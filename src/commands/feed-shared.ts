/** What every `kit escalate feed <service>` command shares: its dependencies and the login item. */
import type { DatabaseSync } from "node:sqlite";
import { syncFeedAuth, type FeedService } from "../feed-sync.js";
import type { ReadCommand } from "../review-receipt-io.js";

export interface FeedDeps {
  run: ReadCommand;
  open: () => DatabaseSync;
}

/** Fail-open: a ledger that cannot be written must not hide the login message. */
export function trackAuthFailure(deps: FeedDeps, service: FeedService): void {
  try {
    const db = deps.open();
    try {
      syncFeedAuth(db, true, service);
    } finally {
      db.close();
    }
  } catch {
    // The login message was already printed.
  }
}
