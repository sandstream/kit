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

/**
 * Reflog messages that mean "this sha was created by replaying an existing commit".
 *
 * Deliberately NOT `rebase (finish)` or `rebase (start)`: those name where the branch ended up, so
 * matching them would excuse a genuine `--no-verify` commit that happened to be the tip when
 * someone rebased. `revert` is absent too — a revert is an ordinary commit and runs the hooks.
 */
export const CREATING_REPLAY_MESSAGE =
  // The word boundary sits inside each alternative on purpose: `\b` after `\)` never matches,
  // since both `)` and the `:` that follows are non-word characters — the first version of this
  // regex silently matched nothing at all, and the test caught it.
  /^(rebase(\s+-i)?\s+\((pick|squash|fixup|reword|edit)\)|cherry-pick\b|am\b)/;

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
  /**
   * Was this commit CREATED by a replay (rebase pick/squash/fixup/reword, cherry-pick, am)?
   *
   * Answered from the reflog, which records the operation that produced each sha. Only the
   * messages that create a commit count: `rebase (finish)` names the branch tip afterwards, so a
   * genuine `--no-verify` commit at the tip of a branch someone then rebased would be excused by
   * it — downgrading a real bypass, which is the one error this must not make.
   *
   * Unknown answers `false`: a reflog expires (30–90 days), and an entry we cannot classify stays
   * counted, the same direction the rest of this module takes.
   */
  createdByReplay(sha: string): boolean;
}

/**
 * Read the JSONL log. Malformed lines are skipped rather than fatal: the writer is a
 * shell hook appending under `|| true`, so a truncated line must not blind the banner
 * to the entries around it.
 */
/**
 * Reasons the post-commit detector writes for a replay rather than a bypass. Recorded rather than
 * dropped: the log is an audit trail, and "this commit was replayed" is a fact worth keeping — it
 * just is not a finding.
 */
export const REPLAY_REASONS = new Set(["replayed"]);

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
): {
  live: SkippedCommitEntry[];
  orphaned: SkippedCommitEntry[];
  replayed: SkippedCommitEntry[];
} {
  const live: SkippedCommitEntry[] = [];
  const orphaned: SkippedCommitEntry[] = [];
  const replayed: SkippedCommitEntry[] = [];
  for (const entry of entries) {
    // A replay is not a bypass, whether the hook already knew that when it wrote the line (newer
    // installs) or the reflog can still prove it (entries written before the hook was fixed).
    if (REPLAY_REASONS.has(entry.reason) || probe.createdByReplay(entry.sha)) {
      replayed.push(entry);
      continue;
    }
    if (probe.containedByAnyRef(entry.sha)) live.push(entry);
    else if (probe.resolves(entry.sha)) orphaned.push(entry);
    else live.push(entry);
  }
  return { live, orphaned, replayed };
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

  // Shas the reflog says were CREATED by a replay. One walk, cached: `git reflog --all` is a
  // single call, and the alternative is one call per logged entry.
  let replayed: Set<string> | null = null;
  const replayedSet = (): Set<string> => {
    if (replayed) return replayed;
    const out = git(["reflog", "--all", "--format=%H %gs"]) ?? "";
    const set = new Set<string>();
    for (const line of out.split("\n")) {
      const space = line.indexOf(" ");
      if (space <= 0) continue;
      const sha = line.slice(0, space);
      const message = line.slice(space + 1);
      if (CREATING_REPLAY_MESSAGE.test(message)) set.add(sha);
    }
    replayed = set;
    return replayed;
  };

  return {
    resolves: (sha) => fullSha(sha) !== null,
    containedByAnyRef: (sha) => {
      const full = fullSha(sha);
      return full !== null && reachableSet().has(full);
    },
    createdByReplay: (sha) => {
      const full = fullSha(sha);
      return full !== null && replayedSet().has(full);
    },
  };
}
