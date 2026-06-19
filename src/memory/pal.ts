/**
 * kit memory — PAL (Pending Action Ledger), folded into the memory store.
 *
 * PAL is the STRUCTURED, actionable layer on top of raw conversation memory:
 * "blocked-on-you" items that survive sessions and auto-close when their verify
 * check starts passing. It lives in the `pending_actions` table of the same
 * SQLite store.
 *
 * SECURITY: a verify is a DECLARATIVE, typed check (see `VerifyCheck`), executed
 * natively (fetch / fs) with a timeout. kit NEVER runs a shell, and never
 * interpolates a stored string into a command, so there is no arbitrary-command-
 * execution sink: a planted or imported value can only ever do what the fixed
 * check types allow (nothing). This is deliberately compatible with autonomous
 * agents: auto-verify needs no human gate, yet a prompt-injected agent cannot
 * plant a command that detonates later in a more-trusted session. Fail-open /
 * no-info aware.
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * A declarative verify check. Fixed shapes only, executed natively by kit (no
 * shell, no arbitrary binary). Add a new shape here only if it can be run as a
 * pure data operation that cannot be coerced into command execution.
 */
export type VerifyCheck =
  | { type: "http-status"; url: string; expect: number }
  | { type: "file-exists"; path: string };

export interface PendingAction {
  id: string;
  status: string;
  title: string;
  detail: string | null;
  scope: string | null;
  kind: string;
  /** Legacy raw shell command from pre-1.4 stores. NEVER executed; kept only so
   *  `kit memory scan` can still find secrets leaked into old rows. */
  verify_cmd: string | null;
  /** JSON-encoded VerifyCheck. The only field auto-verify ever executes. */
  verify_check: string | null;
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
  check?: VerifyCheck;
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
  const kind = input.kind ?? (input.check ? "auto" : "manual");
  const verifyCheck = input.check ? JSON.stringify(input.check) : null;
  db.prepare(
    `INSERT INTO pending_actions (id, status, title, detail, scope, kind, verify_check)
     VALUES (?, 'open', ?, ?, ?, ?, ?)`,
  ).run(id, input.title, input.detail ?? null, input.scope ?? null, kind, verifyCheck);
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

/** One scanner finding to track. `dedupKey` is stable per finding within its
 *  source (e.g. `category:name`), so re-scans map to the same ledger item. */
export interface SyncFinding {
  dedupKey: string;
  title: string;
  detail?: string;
}

export interface SyncFindingsResult {
  added: number;
  reopened: number;
  closed: string[];
}

/** Deterministic pal id for a finding: `${sourceTag}-${6 hex}`. The source tag
 *  prefix lets a per-source sync reconcile only its own items. */
export function findingPalId(sourceTag: string, dedupKey: string): string {
  const h = createHash("sha256").update(dedupKey).digest("hex").slice(0, 6);
  return `${sourceTag}-${h}`;
}

/**
 * Sync a scanner's CURRENT findings into the ledger — the "track" layer.
 *
 * Each finding becomes an open `kind='finding'` item (deterministic id, so a
 * re-scan is idempotent). An item that had cleared (closed) and now recurs is
 * REOPENED; an open item whose finding the scan no longer reports is auto-CLOSED.
 * Finding-presence IS the verify, so this needs no shell and no stored command —
 * same security posture as the rest of PAL. Reconciliation is per source-tag and
 * per scope, so a partial sync never touches another source's or repo's items.
 */
export function palSyncFindings(
  db: DatabaseSync,
  sourceTag: string,
  findings: SyncFinding[],
  opts: { scope?: string } = {},
): SyncFindingsResult {
  const scope = opts.scope ?? null;
  const currentIds = new Set<string>();
  let added = 0;
  let reopened = 0;

  for (const f of findings) {
    const id = findingPalId(sourceTag, f.dedupKey);
    currentIds.add(id);
    const existing = db.prepare("SELECT status FROM pending_actions WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO pending_actions (id, status, title, detail, scope, kind)
         VALUES (?, 'open', ?, ?, ?, 'finding')`,
      ).run(id, f.title, f.detail ?? null, scope);
      added++;
    } else if (existing.status === "closed") {
      db.prepare(
        "UPDATE pending_actions SET status='open', closed_at=NULL, title=?, detail=? WHERE id=?",
      ).run(f.title, f.detail ?? null, id);
      reopened++;
    } else {
      // already open/snoozed — refresh the text so the reminder stays accurate
      db.prepare("UPDATE pending_actions SET title=?, detail=? WHERE id=?").run(
        f.title,
        f.detail ?? null,
        id,
      );
    }
  }

  // Auto-close findings of THIS source + scope that the scan no longer reports.
  const open = db
    .prepare(
      "SELECT id FROM pending_actions WHERE kind='finding' AND status='open' AND id LIKE ? AND scope IS ?",
    )
    .all(`${sourceTag}-%`, scope) as { id: string }[];
  const closed: string[] = [];
  for (const row of open) {
    if (!currentIds.has(row.id) && palDone(db, row.id)) closed.push(row.id);
  }

  return { added, reopened, closed };
}

/**
 * Parse the stored JSON into a VerifyCheck, defensively. Only known shapes are
 * accepted; anything malformed, unknown, or legacy returns null and is never
 * executed. This is the gate that makes a planted/imported value inert.
 */
function parseCheck(json: string | null): VerifyCheck | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.type === "file-exists" && typeof o.path === "string") {
    return { type: "file-exists", path: o.path };
  }
  if (o.type === "http-status" && typeof o.url === "string" && typeof o.expect === "number") {
    return { type: "http-status", url: o.url, expect: o.expect };
  }
  return null;
}

/**
 * Run a declarative verify check. true = pass, false = ran but failed, null =
 * no-info (leave state unchanged). Executed NATIVELY (fetch / fs), never through
 * a shell and never by interpolating a stored string into a command, so there is
 * no command-execution sink: a check can only do what its fixed type allows.
 */
async function runCheck(check: VerifyCheck): Promise<boolean | null> {
  try {
    if (check.type === "file-exists") {
      return existsSync(check.path);
    }
    // http-status: kit makes the request itself; the URL is data, not a command.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(check.url, { signal: controller.signal, redirect: "manual" });
      return res.status === check.expect;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null; // network/fs error or timeout → no-info
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
export async function palAutoVerify(
  db: DatabaseSync,
  confirmPasses = 2,
): Promise<AutoVerifyResult> {
  const out: AutoVerifyResult = { checked: 0, closed: [], reopened: [] };
  const rows = db
    .prepare(
      "SELECT * FROM pending_actions WHERE kind='auto' AND verify_check IS NOT NULL AND status IN ('open','closed')",
    )
    .all() as unknown as PendingAction[];
  for (const r of rows) {
    const check = parseCheck(r.verify_check);
    if (!check) continue; // malformed/unknown/legacy shape -> never executed
    const result = await runCheck(check);
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
