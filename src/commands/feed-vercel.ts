/** `kit escalate feed vercel`: failed production deploys as action items. */
import { FeedAuthError } from "../feed-github.js";
import { syncFeedAuth, syncVercelFeed } from "../feed-sync.js";
import { fetchVercelFeed, type VercelFeed } from "../feed-vercel.js";
import type { SyncFindingsResult } from "../memory/pal.js";
import { flagValue, hasFlag } from "../utils/flags.js";
import { trackAuthFailure, type FeedDeps } from "./feed-shared.js";

function reconcile(deps: FeedDeps, feed: VercelFeed): SyncFindingsResult | null {
  const db = deps.open();
  try {
    const result = syncVercelFeed(db, feed);
    syncFeedAuth(db, false, "vercel");
    return result;
  } finally {
    db.close();
  }
}

function describeFeed(feed: VercelFeed, sync: SyncFindingsResult | null, dry: boolean): string[] {
  const lines = [`Vercel (${feed.scope})${dry ? " dry run, nothing written" : ""}`];
  for (const f of feed.production ?? []) lines.push(`  ${f.title}`);
  if (feed.production?.length === 0) lines.push("  nothing is broken");
  for (const note of feed.notes) lines.push(`  ${note}`);
  if (sync) {
    lines.push(
      `  Production: ${sync.added} new, ${sync.reopened} reopened, ${sync.closed.length} closed`,
    );
  }
  return lines;
}

export function runVercel(
  argv: readonly string[],
  deps: FeedDeps,
  out: (line: string) => void,
  err: (line: string) => void,
): boolean {
  const dry = hasFlag(argv, "--dry-run");
  try {
    const feed = fetchVercelFeed(deps.run, flagValue(argv, "--team"));
    const sync = dry ? null : reconcile(deps, feed);
    if (hasFlag(argv, "--json")) {
      out(JSON.stringify({ scope: feed.scope, production: sync, notes: feed.notes }));
    } else {
      for (const line of describeFeed(feed, sync, dry)) out(line);
    }
    return feed.production !== null;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    if (error instanceof FeedAuthError && !dry) trackAuthFailure(deps, "vercel");
    return false;
  }
}
