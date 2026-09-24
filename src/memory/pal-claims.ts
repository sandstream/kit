import type { DatabaseSync } from "node:sqlite";
import {
  claimContextOwner,
  readActionHistory,
  revisionTransaction,
  writeActionRevision,
  takeoverActionHistory,
  PalStateError,
  type PalMutationResult,
  type PalWriteOptions,
  type PalClaimOwner,
} from "./pal-revisions.js";

export interface PalClaimOptions extends PalWriteOptions {
  owner: PalClaimOwner;
  expectedFrontier: string;
  label?: string;
}

function claimLabel(opts: PalClaimOptions): string {
  if (opts.label !== undefined && (typeof opts.label !== "string" || !opts.label.trim()))
    throw new RangeError("Claim label must be nonempty text");
  return opts.label ?? opts.owner.harness;
}

export function palRenew(db: DatabaseSync, id: string, opts: PalClaimOptions): PalMutationResult {
  claimContextOwner(opts);
  return revisionTransaction(db, () => {
    const before = readActionHistory(db, id);
    if (!before) return { status: "missing" };
    if (before.frontier !== opts.expectedFrontier) return { status: "stale", view: before };
    if (before.conflict)
      throw new PalStateError("conflict", "Contested claims require explicit takeover");
    if (before.heads[0].state.status !== "claimed") return { status: "unchanged", view: before };
    writeActionRevision(
      db,
      id,
      () =>
        db
          .prepare(
            "UPDATE pending_actions SET claimed_at=datetime('now') WHERE id=? AND status='claimed'",
          )
          .run(id),
      opts,
      true,
    );
    return { status: "applied", view: readActionHistory(db, id)! };
  });
}

export function palTakeover(
  db: DatabaseSync,
  id: string,
  opts: PalClaimOptions & { take?: string },
): PalMutationResult {
  const owner = claimContextOwner(opts);
  const label = claimLabel(opts);
  return revisionTransaction(db, () => {
    const before = readActionHistory(db, id);
    if (!before) return { status: "missing" };
    if (before.frontier !== opts.expectedFrontier) return { status: "stale", view: before };
    if (!before.heads.some((head) => head.state.status === "claimed"))
      return { status: "unchanged", view: before };
    const chosen =
      opts.take === undefined && before.heads.length === 1
        ? before.heads[0]
        : before.heads.find((head) => head.id === opts.take);
    if (!chosen)
      throw new RangeError("Takeover requires a chosen current head when alternatives exist");
    const claimedAt = db.prepare("SELECT datetime('now') AS value").get()!.value;
    return takeoverActionHistory(db, id, {
      owner,
      expectedFrontier: opts.expectedFrontier,
      choice: {
        state: {
          ...chosen.state,
          status: "claimed",
          claim_owner: owner,
          claimed_by: label,
          claimed_at: String(claimedAt),
          snooze_until: null,
          closed_at: null,
          next_check: null,
        },
      },
    });
  });
}

/** A receipt fences this observed store, not external work performed by offline replicas. */
export function palClaim(db: DatabaseSync, id: string, opts: PalClaimOptions): PalMutationResult {
  const owner = claimContextOwner(opts);
  const label = claimLabel(opts);
  return revisionTransaction(db, () => {
    const before = readActionHistory(db, id);
    if (!before) return { status: "missing" };
    if (before.frontier !== opts.expectedFrontier) return { status: "stale", view: before };
    const result = writeActionRevision(
      db,
      id,
      () =>
        db
          .prepare(
            `UPDATE pending_actions SET status='claimed', claimed_by=?, claim_owner=?,
       claimed_at=datetime('now') WHERE id=? AND status='open'`,
          )
          .run(label, JSON.stringify(owner), id),
      opts,
    );
    return {
      status: Number(result.changes) ? "applied" : "unchanged",
      view: readActionHistory(db, id)!,
    };
  });
}
