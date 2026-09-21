import type { DatabaseSync } from "node:sqlite";
import {
  assertClaimContext,
  readActionHistory,
  PalStateError,
  type PalClaimOwner,
} from "./pal-revisions.js";
import { removeActionGrant } from "./pal-authority.js";
import { withPalWrite } from "./pal-write-guard.js";

export interface PalForgetResult {
  status: "applied" | "missing" | "stale";
  syncId?: string;
  projectionGone?: boolean;
  historyGone?: boolean;
  tombstoned?: boolean;
  ok?: boolean;
}

function eraseAction(db: DatabaseSync, syncId: string): void {
  withPalWrite(db, { mode: "forget", syncId }, () => {
    db.prepare("INSERT OR IGNORE INTO pal_tombstones (sync_id) VALUES (?)").run(syncId);
    db.prepare("DELETE FROM pal_revisions WHERE sync_id=?").run(syncId);
    db.prepare("DELETE FROM pending_actions WHERE sync_id=?").run(syncId);
  });
}

/** Logical store erasure, not erasure of retained backups or underlying storage blocks. */
export function palForget(
  db: DatabaseSync,
  id: string,
  opts: { expectedFrontier: string; owner?: PalClaimOwner },
): PalForgetResult {
  if (typeof opts.expectedFrontier !== "string" || !/^[a-f0-9]{64}$/.test(opts.expectedFrontier))
    throw new RangeError("Expected frontier must be a 64-character lowercase hex digest");
  let grant: string | undefined;
  // Own the commit: removing an external approval before a caller rolls back is unsafe.
  db.exec("BEGIN IMMEDIATE");
  let result: PalForgetResult;
  try {
    const view = readActionHistory(db, id);
    if (!view) result = { status: "missing" };
    else if (view.frontier !== opts.expectedFrontier) result = { status: "stale" };
    else {
      const claims = view.heads.filter((head) => head.state.status === "claimed");
      if (claims.length && view.conflict)
        throw new PalStateError(
          "conflict",
          "Contested claims require explicit takeover before forgetting",
        );
      for (const head of claims) assertClaimContext(head.state, opts);
      const row = db.prepare("SELECT verify_grant FROM pending_actions WHERE id=?").get(id);
      if (typeof row?.verify_grant === "string") grant = row.verify_grant;
      eraseAction(db, view.syncId);
      const projectionGone = !db
        .prepare("SELECT 1 FROM pending_actions WHERE sync_id=?")
        .get(view.syncId);
      const historyGone = !db
        .prepare("SELECT 1 FROM pal_revisions WHERE sync_id=?")
        .get(view.syncId);
      const tombstoned = !!db
        .prepare("SELECT 1 FROM pal_tombstones WHERE sync_id=?")
        .get(view.syncId);
      if (!projectionGone || !historyGone || !tombstoned)
        throw new Error("Task erasure proof failed");
      result = {
        status: "applied",
        syncId: view.syncId,
        projectionGone,
        historyGone,
        tombstoned,
        ok: true,
      };
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* Preserve the original SQLite failure. */
    }
    throw error;
  }
  removeActionGrant(db, grant);
  return result;
}

/** Deletions precede graph validation so erased histories can never be reintroduced. */
export function mergeActionTombstones(target: DatabaseSync, source: DatabaseSync): void {
  const present = source
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pal_tombstones'")
    .get();
  if (!present) return;
  for (const row of source.prepare("SELECT sync_id FROM pal_tombstones").all()) {
    if (
      typeof row.sync_id !== "string" ||
      !/^(?:[a-f0-9]{32}|legacy-[a-f0-9]{64})$/.test(row.sync_id)
    )
      throw new Error("Invalid pending-action deletion identity");
    eraseAction(target, row.sync_id);
  }
  // Merge can run inside a caller's transaction. External hash-only markers remain
  // inert orphans; deleting them here would break approvals if the caller rolls back.
}
