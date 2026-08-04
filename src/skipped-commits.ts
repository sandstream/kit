/**
 * The bypass log (`.kit-skipped-commits.jsonl`) is append-only: the post-commit
 * detector writes one line per commit that skipped the pre-commit hook, and nothing
 * ever removes a line. That is right for an audit trail and wrong for a counter —
 * a squash-merge keeps the change and discards the commit, so the recorded sha ends
 * up in no ref at all while the banner keeps reporting it. Three such entries sat in
 * this repo's own log, counted on every `kit` invocation, describing commits that no
 * longer exist in any branch, tag or remote.
 *
 * So an entry is set aside only when it can be DISPROVED: the object is present and
 * no ref contains it. Anything unverifiable — a log carried between clones, an object
 * gc'd away, a directory that is not a git repo — stays counted. A bypass we cannot
 * check is not a bypass we can dismiss, and this banner is the only place a
 * `--no-verify` becomes visible after the fact.
 */
import { execFileSync } from "node:child_process";

export interface SkippedCommitEntry {
  timestamp: string;
  sha: string;
  reason: string;
  user?: string;
}

/**
 * Reachability questions asked of the repository, injected so the classification rule
 * can be tested without building a git fixture for every case.
 */
export interface ReachabilityProbe {
  /** Is this sha a commit object present in the store? */
  resolves(sha: string): boolean;
  /** Does at least one ref reach it? */
  containedByAnyRef(sha: string): boolean;
}

/**
 * Read the JSONL log. Malformed lines are skipped rather than fatal: the writer is a
 * shell hook appending under `|| true`, so a truncated line must not blind the banner
 * to the entries around it.
 */
export function parseSkippedCommits(content: string): SkippedCommitEntry[] {
  const entries: SkippedCommitEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SkippedCommitEntry>;
      if (typeof parsed.sha !== "string" || !parsed.sha) continue;
      entries.push({
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
        sha: parsed.sha,
        reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
        user: typeof parsed.user === "string" ? parsed.user : undefined,
      });
    } catch {
      /* malformed line — best-effort log, keep reading */
    }
  }
  return entries;
}

/**
 * Split the log into entries still reachable from some ref (`live`) and entries the
 * repository can prove landed nowhere (`orphaned`). Unverifiable entries land in
 * `live` — see the file header for why that direction is the safe one.
 */
export function partitionSkippedCommits(
  entries: SkippedCommitEntry[],
  probe: ReachabilityProbe,
): { live: SkippedCommitEntry[]; orphaned: SkippedCommitEntry[] } {
  const live: SkippedCommitEntry[] = [];
  const orphaned: SkippedCommitEntry[] = [];
  for (const entry of entries) {
    if (probe.containedByAnyRef(entry.sha)) live.push(entry);
    else if (probe.resolves(entry.sha)) orphaned.push(entry);
    else live.push(entry);
  }
  return { live, orphaned };
}

/**
 * A probe backed by git in `cwd`. Reachability comes from a single `rev-list` walk
 * rather than one `git` call per entry; only the shas missing from that set need an
 * object lookup. Every git failure answers "unknown" (false), which the partition
 * reads as keep-counting.
 */
export function gitReachabilityProbe(cwd: string): ReachabilityProbe {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };

  let reachable: Set<string> | null = null;
  const reachableSet = (): Set<string> => {
    if (reachable) return reachable;
    // `HEAD` is named alongside `--all` so a detached HEAD — mid-rebase, mid-bisect,
    // exactly when a fresh commit has no branch yet — is not mistaken for orphaned.
    // It is not a ref `--all` enumerates. Fall back if HEAD is unborn.
    const out = git(["rev-list", "--all", "HEAD"]) ?? git(["rev-list", "--all"]);
    reachable = new Set(
      (out ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    return reachable;
  };

  // The log stores full shas, but a hand-edited or abbreviated one must not be read as
  // "absent from the reachable set" and thereby pruned.
  const resolved = new Map<string, string | null>();
  const fullSha = (sha: string): string | null => {
    const cached = resolved.get(sha);
    if (cached !== undefined) return cached;
    const out = git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    const value = out?.trim() || null;
    resolved.set(sha, value);
    return value;
  };

  return {
    resolves: (sha) => fullSha(sha) !== null,
    containedByAnyRef: (sha) => {
      const full = fullSha(sha);
      return full !== null && reachableSet().has(full);
    },
  };
}
