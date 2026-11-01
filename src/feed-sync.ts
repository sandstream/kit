/** Reconcile a GitHub feed with the pending action ledger. One source tag per kind, one scope per repo. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GithubFeed } from "./feed-github.js";
import { palSyncFindings, type SyncFindingsResult } from "./memory/pal.js";

export interface FeedSyncResult {
  /** Null when the source could not be read, so nothing was reconciled. */
  ci: SyncFindingsResult | null;
  dependabot: SyncFindingsResult | null;
}

/**
 * Items have no scope, so every project's list, the status line and the session pickup show them.
 * A scope is a project path, and a failing workflow belongs to a repository, not to the folder
 * the command ran in: with a repo-shaped scope no list would ever show the item. Each repository
 * gets its own source tag instead, so a sync only reconciles its own repository's items.
 */
function tag(kind: "ci" | "dep", repo: string): string {
  return `${kind}${createHash("sha256").update(repo).digest("hex").slice(0, 8)}`;
}

export function syncGithubFeed(db: DatabaseSync, feed: GithubFeed): FeedSyncResult {
  return {
    ci: feed.ci ? palSyncFindings(db, tag("ci", feed.repo), feed.ci) : null,
    dependabot: feed.dependabot
      ? palSyncFindings(db, tag("dep", feed.repo), feed.dependabot)
      : null,
  };
}

/** A feed that cannot log in is itself something to act on, or the mail it replaces would just stop. */
export function syncFeedAuth(db: DatabaseSync, broken: boolean): void {
  palSyncFindings(
    db,
    "feedauth",
    broken
      ? [
          {
            dedupKey: "github",
            title: "GitHub feed: not logged in",
            detail: "kit escalate feed github cannot read GitHub. Run: gh auth login",
          },
        ]
      : [],
  );
}
