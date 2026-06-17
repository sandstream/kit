/**
 * kit memory — PAL (Pending Action Ledger), folded into the memory store.
 *
 * PAL is the STRUCTURED, actionable layer on top of raw conversation memory:
 * "blocked-on-you" items that survive sessions and auto-close when their verify
 * command starts passing. It lives in the `pending_actions` table of the same
 * SQLite store. Deterministic; the only side effect is running operator-defined
 * verify commands (local shell, with a timeout). Fail-open / no-info aware.
 */
import { randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface PendingAction {
  id: string;
  status: string;
  title: string;
  detail: string | null;
  scope: string | null;
  kind: string;
  verify_cmd: string | null;
  created_at: string | null;
  next_check: string | null;
  snooze_until: string | null;
  closed_at: string | null;
  verify_passes: number;
}

export interface PalAddInput {
  title: string;
  detail?: string;
  scope?: string;
  kind?: "manual" | "auto";
  verifyCmd?: string;
}

function newId(db: DatabaseSync): string {
  for (let i = 0; i < 100; i++) {
    const id = randomBytes(2).toString("hex"); // 4 hex chars, e.g. "ec95"
    if (!db.prepare("SELECT 1 FROM pending_actions WHERE id = ?").get(id)) return id;
  }
  throw new Error("could not allocate a unique pending-action id");
}

export function palAdd(db: DatabaseSync, input: PalAddInput): string {
  const id = newId(db);
  const kind = input.kind ?? (input.verifyCmd ? "auto" : "manual");
  db.prepare(
    `INSERT INTO pending_actions (id, status, title, detail, scope, kind, verify_cmd)
     VALUES (?, 'open', ?, ?, ?, ?, ?)`,
  ).run(id, input.title, input.detail ?? null, input.scope ?? null, kind, input.verifyCmd ?? null);
  return id;
}

export interface PalListOptions {
  status?: string;
  /** Restrict to this scope plus globally-scoped (NULL) items. Omit = every scope. */
  scope?: string;
}

export function palList(db: DatabaseSync, opts: PalListOptions = {}): PendingAction[] {
  const status = opts.status ?? "open";
  if (opts.scope !== undefined) {
    return db
      .prepare(
        "SELECT * FROM pending_actions WHERE status = ? AND (scope = ? OR scope IS NULL) ORDER BY created_at, id",
      )
      .all(status, opts.scope) as unknown as PendingAction[];
  }
  return db
    .prepare("SELECT * FROM pending_actions WHERE status = ? ORDER BY created_at, id")
    .all(status) as unknown as PendingAction[];
}

export function palDone(db: DatabaseSync, id: string): boolean {
  const res = db
    .prepare(
      "UPDATE pending_actions SET status='closed', closed_at=datetime('now') WHERE id=? AND status!='closed'",
    )
    .run(id);
  return Number(res.changes) > 0;
}

export function palSnooze(db: DatabaseSync, id: string, days: number): boolean {
  const d = Math.max(1, Math.floor(days));
  const res = db
    .prepare(
      "UPDATE pending_actions SET status='snoozed', snooze_until=datetime('now', ?) WHERE id=?",
    )
    .run(`+${d} days`, id);
  return Number(res.changes) > 0;
}

/**
 * Run a verify command. true = pass (exit 0), false = ran but failed, null = no-info.
 *
 * SECURITY: this runs `cmd` through a shell on purpose — verify commands routinely
 * need pipes / `&&` (e.g. `curl -fsS … | grep 200`). The trust boundary: `verify_cmd`
 * is OPERATOR-AUTHORED and lives only in the PERSONAL store (~/.kit/memory.db); running
 * it is equivalent to the operator running their own command — no untrusted data is
 * interpolated, so this is not a command-injection sink. INVARIANT for Track D (shared
 * memory): shared/synced items must NEVER carry an executable `verify_cmd` that runs
 * unreviewed — only manual items or review-gated verifies cross the sharing boundary.
 */
function runVerify(cmd: string): boolean | null {
  try {
    execSync(cmd, { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    if (typeof status === "number") return false; // ran, non-zero exit
    return null; // spawn error / timeout → no-info, leave state unchanged
  }
}

export interface AutoVerifyResult {
  checked: number;
  closed: string[];
  reopened: string[];
}

/**
 * Auto-verify `auto` items. An OPEN item that passes `confirmPasses` consecutive
 * times is closed (a pass increments the streak, a fail resets it). A CLOSED item
 * whose verify now FAILS is reopened (reopen-on-regress). No-info leaves it alone.
 */
export function palAutoVerify(db: DatabaseSync, confirmPasses = 2): AutoVerifyResult {
  const out: AutoVerifyResult = { checked: 0, closed: [], reopened: [] };
  const rows = db
    .prepare(
      "SELECT * FROM pending_actions WHERE kind='auto' AND verify_cmd IS NOT NULL AND status IN ('open','closed')",
    )
    .all() as unknown as PendingAction[];
  for (const r of rows) {
    const result = runVerify(r.verify_cmd as string);
    if (result === null) continue; // no-info
    out.checked++;
    if (r.status === "open") {
      if (result) {
        const passes = r.verify_passes + 1;
        if (passes >= confirmPasses) {
          db.prepare(
            "UPDATE pending_actions SET status='closed', closed_at=datetime('now'), verify_passes=? WHERE id=?",
          ).run(passes, r.id);
          out.closed.push(r.id);
        } else {
          db.prepare("UPDATE pending_actions SET verify_passes=? WHERE id=?").run(passes, r.id);
        }
      } else if (r.verify_passes !== 0) {
        db.prepare("UPDATE pending_actions SET verify_passes=0 WHERE id=?").run(r.id);
      }
    } else if (r.status === "closed" && !result) {
      db.prepare(
        "UPDATE pending_actions SET status='open', verify_passes=0, closed_at=NULL WHERE id=?",
      ).run(r.id);
      out.reopened.push(r.id);
    }
  }
  return out;
}

// ── Migration from the legacy python PAL ledger ───────────────────────────────

export function getLegacyLedgerPath(): string {
  return process.env.KIT_PAL_LEDGER ?? join(homedir(), ".claude", "pal", "ledger.jsonl");
}

interface LegacyEntry {
  id?: string;
  ts?: string;
  status?: string;
  repo?: string;
  title?: string;
  why?: string;
  next_check?: string;
  pass_streak?: number;
  verify?: string;
}

/** Import the old `~/.claude/pal/ledger.jsonl` into pending_actions. Idempotent (by id). */
export function importLegacyLedger(
  db: DatabaseSync,
  path: string = getLegacyLedgerPath(),
): { imported: number } {
  if (!existsSync(path)) return { imported: 0 };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { imported: 0 };
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pending_actions
     (id, status, title, detail, scope, kind, verify_cmd, created_at, next_check, verify_passes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let imported = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: LegacyEntry;
    try {
      e = JSON.parse(t) as LegacyEntry;
    } catch {
      continue;
    }
    if (!e.id || !e.title) continue;
    const status = e.status === "done" ? "closed" : (e.status ?? "open");
    // SECURITY: a `verify` command read from a file is NOT operator-authored in
    // this session — the ledger path is overridable (KIT_PAL_LEDGER) and its
    // content is arbitrary. Import every legacy entry as `manual` with no
    // executable command, so palAutoVerify can never run a command that crossed
    // the file boundary. Re-authorise auto-verify by re-adding via `pal add`
    // (typed input). Invariant: kind='auto' + verify_cmd is only ever created
    // by palAdd.
    const res = insert.run(
      e.id,
      status,
      e.title,
      e.why ?? null,
      e.repo ?? null,
      "manual",
      null,
      e.ts ?? null,
      e.next_check ?? null,
      e.pass_streak ?? 0,
    );
    if (Number(res.changes) > 0) imported++;
  }
  return { imported };
}
