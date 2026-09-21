import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PendingAction, VerifyCheck } from "./pal.js";
import { parseVerifyCheck } from "./pal-configure.js";
import { actionCheckIsAuthorized } from "./pal-authority.js";
import { inspectAction } from "./pal-check-storage.js";
import { revisionTransaction, writeActionRevision } from "./pal-revisions.js";

const UNVERIFIED_DETAILS = {
  "state-conflict":
    "Pending action has unresolved alternatives; inspect with pal show and resolve before verification.",
  "no-local-approval":
    "Verification has no matching local approval; use pal configure to supply a local check or select --manual.",
  "invalid-check":
    "Stored verification check is invalid; use pal configure to replace it or select --manual.",
  "unbound-path":
    "Relative file check has no creation directory; use pal configure to bind a target or select --manual.",
  "unavailable-origin":
    "Creation directory is unavailable; restore access before retrying verification.",
  "no-result": "Check could not be completed; restore access or connectivity before retrying.",
} as const;

type CheckResult = boolean | { reason: keyof typeof UNVERIFIED_DETAILS };

/** Unknown or legacy check shapes never acquire permission to execute. */
function parseCheck(json: string | null): VerifyCheck | null {
  try {
    return parseVerifyCheck(JSON.parse(json ?? "null"));
  } catch {
    return null;
  }
}

function fileCheck(path: string, originRoot: string | null): CheckResult {
  if (!isAbsolute(path)) {
    // Recall aliases and the caller's cwd do not change what a stored check means.
    if (!originRoot || !isAbsolute(originRoot)) return { reason: "unbound-path" };
    try {
      if (!statSync(originRoot).isDirectory()) return { reason: "unavailable-origin" };
    } catch {
      return { reason: "unavailable-origin" };
    }
    path = resolve(originRoot, path);
  }
  try {
    statSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : { reason: "no-result" };
  }
}

/** Native checks only; stored strings are never shell commands. Unavailable is not failure evidence. */
async function runCheck(check: VerifyCheck, originRoot: string | null): Promise<CheckResult> {
  try {
    if (check.type === "file-exists") return fileCheck(check.path, originRoot);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(check.url, { signal: controller.signal, redirect: "manual" });
      return res.status === check.expect;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { reason: "no-result" };
  }
}

export interface AutoVerifyResult {
  checked: number;
  closed: string[];
  reopened: string[];
  /** Observations changed before a queued check started or its result could apply. */
  stale: string[];
  unverified: { id: string; reason: keyof typeof UNVERIFIED_DETAILS; detail: string }[];
}

type VersionedAction = PendingAction & { local_version: string };

async function observeCheck(db: DatabaseSync, row: VersionedAction): Promise<CheckResult> {
  if (row.state_conflict) return { reason: "state-conflict" };
  const check = parseCheck(row.verify_check);
  if (!check) return { reason: "invalid-check" };
  if (
    check.type === "file-exists" &&
    !isAbsolute(check.path) &&
    (!row.origin_root || !isAbsolute(row.origin_root))
  )
    return { reason: "unbound-path" };
  if (!actionCheckIsAuthorized(db, row)) return { reason: "no-local-approval" };
  return runCheck(check, row.origin_root);
}

function applyResult(db: DatabaseSync, row: VersionedAction, pass: boolean, required: number) {
  const passes = pass ? row.verify_passes + (row.status === "open" ? 1 : 0) : 0;
  const closes = row.status === "open" && pass && passes >= required;
  const reopens = row.status === "closed" && !pass;
  const transition = closes
    ? "status = 'closed', closed_at = datetime('now'),"
    : reopens
      ? "status = 'open', closed_at = NULL,"
      : "";
  const cleanup =
    closes || reopens
      ? "claimed_by = NULL, claimed_at = NULL, snooze_until = NULL, next_check = NULL,"
      : "";
  const applied = writeActionRevision(db, row.id, () =>
    db
      .prepare(
        `
    UPDATE pending_actions SET ${transition} ${cleanup} verify_passes = ?
    WHERE id = ? AND EXISTS (
      SELECT 1 FROM pending_action_versions WHERE action_id = pending_actions.id AND token = ?
    )
  `,
      )
      .run(passes, row.id, row.local_version),
  );
  if (!Number(applied.changes)) return "stale";
  if (closes) return "closed";
  if (reopens) return "reopened";
}

/** Consecutive passes close open work; failure reopens closed work. Stale results cannot write. */
export async function palAutoVerify(
  db: DatabaseSync,
  confirmPasses = 2,
): Promise<AutoVerifyResult> {
  const out: AutoVerifyResult = { checked: 0, closed: [], reopened: [], stale: [], unverified: [] };
  const rows = db
    .prepare(
      `SELECT action.*, version.token AS local_version FROM pending_actions AS action
       JOIN pending_action_versions AS version ON version.action_id = action.id
       WHERE kind='auto' AND verify_definition IS NOT NULL
         AND (status IN ('open','closed') OR state_conflict=1)`,
    )
    .all() as unknown as VersionedAction[];
  const current = db.prepare(
    "SELECT 1 FROM pending_action_versions WHERE action_id = ? AND token = ?",
  );
  for (const stored of rows) {
    const row = { ...inspectAction(stored), local_version: stored.local_version };
    if (!current.get(row.id, row.local_version)) {
      out.stale.push(row.id);
      continue;
    }
    const result = await observeCheck(db, row);
    if (typeof result !== "boolean") {
      if (!current.get(row.id, row.local_version)) {
        out.stale.push(row.id);
        continue;
      }
      out.unverified.push({
        id: row.id,
        reason: result.reason,
        detail: UNVERIFIED_DETAILS[result.reason],
      });
      continue;
    }
    if (!actionCheckIsAuthorized(db, row)) {
      if (!current.get(row.id, row.local_version)) out.stale.push(row.id);
      else
        out.unverified.push({
          id: row.id,
          reason: "no-local-approval",
          detail: UNVERIFIED_DETAILS["no-local-approval"],
        });
      continue;
    }
    out.checked++;
    const applied = revisionTransaction(db, () => {
      if (!current.get(row.id, row.local_version)) return "stale";
      return applyResult(db, row, result, confirmPasses);
    });
    if (applied) out[applied].push(row.id);
  }
  return out;
}
