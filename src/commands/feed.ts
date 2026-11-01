/** Feed what outside services report as broken into the pending action ledger. */
import { FeedAuthError, fetchGithubFeed, parseRepo, type GithubFeed } from "../feed-github.js";
import { syncFeedAuth, syncGithubFeed, type FeedSyncResult } from "../feed-sync.js";
import type { DatabaseSync } from "node:sqlite";
import { openMemoryDb } from "../memory/db.js";
import { defaultReadCommand, type ReadCommand } from "../review-receipt-io.js";
import { flagValue, hasFlag } from "../utils/flags.js";

export interface FeedDeps {
  run: ReadCommand;
  open: () => DatabaseSync;
}

const USAGE = "Use: kit escalate feed github [--repo owner/name] [--dry-run] [--json]";

function currentRepo(argv: readonly string[], deps: FeedDeps): string {
  const given = flagValue(argv, "--repo");
  if (given !== undefined) return parseRepo(given);
  const args = ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"];
  return parseRepo(deps.run("gh", args, process.cwd()).trim());
}

function reconcile(deps: FeedDeps, feed: GithubFeed): FeedSyncResult {
  const db = deps.open();
  try {
    const result = syncGithubFeed(db, feed);
    syncFeedAuth(db, false);
    return result;
  } finally {
    db.close();
  }
}

function describeFeed(feed: GithubFeed, sync: FeedSyncResult, dry: boolean): string[] {
  const lines = [`${feed.repo} (${feed.branch})${dry ? " dry run, nothing written" : ""}`];
  for (const f of [...(feed.ci ?? []), ...(feed.dependabot ?? [])]) lines.push(`  ${f.title}`);
  if (feed.ci?.length === 0 && feed.dependabot?.length === 0) lines.push("  nothing is broken");
  for (const note of feed.notes) lines.push(`  ${note}`);
  for (const [label, r] of [
    ["CI", sync.ci],
    ["Dependabot", sync.dependabot],
  ] as const) {
    if (r)
      lines.push(`  ${label}: ${r.added} new, ${r.reopened} reopened, ${r.closed.length} closed`);
  }
  return lines;
}

export function runFeed(
  argv: readonly string[],
  deps: FeedDeps,
  out: (line: string) => void,
  err: (line: string) => void,
): boolean {
  if (argv[1] !== "github") {
    err(USAGE);
    return false;
  }
  const dry = hasFlag(argv, "--dry-run");
  try {
    const feed = fetchGithubFeed(currentRepo(argv, deps), deps.run);
    const sync = dry ? { ci: null, dependabot: null } : reconcile(deps, feed);
    if (hasFlag(argv, "--json")) {
      const { repo, branch, notes } = feed;
      out(JSON.stringify({ repo, branch, ci: sync.ci, dependabot: sync.dependabot, notes }));
    } else {
      for (const line of describeFeed(feed, sync, dry)) out(line);
    }
    return feed.ci !== null || feed.dependabot !== null;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    if (error instanceof FeedAuthError && !dry) trackAuthFailure(deps);
    return false;
  }
}

/** Fail-open: a ledger that cannot be written must not hide the message above. */
function trackAuthFailure(deps: FeedDeps): void {
  try {
    const db = deps.open();
    try {
      syncFeedAuth(db, true);
    } finally {
      db.close();
    }
  } catch {
    // The login message was already printed.
  }
}

export async function cmdFeed(): Promise<boolean> {
  return runFeed(
    process.argv.slice(3),
    { run: defaultReadCommand, open: () => openMemoryDb() },
    (line) => console.log(line),
    (line) => console.error(line),
  );
}
