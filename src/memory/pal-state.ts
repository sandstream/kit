import type { DatabaseSync } from "node:sqlite";
import { writeActionRevision, type PalWriteOptions } from "./pal-revisions.js";

export function palDone(db: DatabaseSync, id: string, opts: PalWriteOptions = {}): boolean {
  const result = writeActionRevision(
    db,
    id,
    () =>
      db
        .prepare(
          `
    UPDATE pending_actions SET status='closed', closed_at=datetime('now'),
      claimed_by=NULL, claimed_at=NULL, claim_owner=NULL, snooze_until=NULL, next_check=NULL, verify_passes=0
    WHERE id=? AND status!='closed'
  `,
        )
        .run(id),
    opts,
  );
  return Number(result.changes) > 0;
}

export function palSnooze(
  db: DatabaseSync,
  id: string,
  days: number,
  opts: PalWriteOptions = {},
): boolean {
  if (!Number.isSafeInteger(days) || days < 1)
    throw new RangeError("snooze days must be a positive safe whole number");
  const until = db.prepare("SELECT datetime('now', ?) AS value").get(`+${days} days`)?.value;
  if (typeof until !== "string")
    throw new RangeError("snooze date falls outside the supported calendar");
  const result = writeActionRevision(
    db,
    id,
    () =>
      db
        .prepare(
          `
    UPDATE pending_actions SET status='snoozed', snooze_until=?, closed_at=NULL,
      claimed_by=NULL, claimed_at=NULL, claim_owner=NULL, next_check=NULL, verify_passes=0
    WHERE id=? AND status IN ('open', 'claimed', 'snoozed')
  `,
        )
        .run(until, id),
    opts,
  );
  return Number(result.changes) > 0;
}

export function palRelease(db: DatabaseSync, id: string, opts: PalWriteOptions = {}): boolean {
  const result = writeActionRevision(
    db,
    id,
    () =>
      db
        .prepare(
          `
    UPDATE pending_actions SET status='open', claimed_by=NULL, claimed_at=NULL, claim_owner=NULL,
      snooze_until=NULL, closed_at=NULL, next_check=NULL, verify_passes=0
    WHERE id=? AND status IN ('claimed', 'snoozed')
  `,
        )
        .run(id),
    opts,
  );
  return Number(result.changes) > 0;
}

/** Closing remains terminal until an explicit reopen or an automatic check regression. */
export function palReopen(db: DatabaseSync, id: string, opts: PalWriteOptions = {}): boolean {
  const result = writeActionRevision(
    db,
    id,
    () =>
      db
        .prepare(
          `
    UPDATE pending_actions SET status='open', claimed_by=NULL, claimed_at=NULL, claim_owner=NULL,
      snooze_until=NULL, closed_at=NULL, next_check=NULL, verify_passes=0
    WHERE id=? AND status='closed'
  `,
        )
        .run(id),
    opts,
  );
  return Number(result.changes) > 0;
}
