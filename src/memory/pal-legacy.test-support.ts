// Frozen verifier declarations from kit commit 25f1cf4e3641ec7c4397c26f5907acbc5947ec91, src/memory/pal.ts.
// Bodies retained verbatim; this test-only fixture must not import the current verifier.
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
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
  /** Device where this item was created (v5+); NULL on legacy rows. */
  origin_device: string | null;
  /** Absolute project path at creation (v5+) — used by `pal prune`. */
  origin_root: string | null;
  /** Agent/session that atomically claimed this open item (v6+); NULL = unclaimed. */
  claimed_by: string | null;
  /** When the claim was taken (v6+). */
  claimed_at: string | null;
}

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
