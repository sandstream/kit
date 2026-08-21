/**
 * The bypass banner counts commits that skipped the pre-commit hook. Its input is an
 * append-only log, so an entry survives the commit it describes: after a squash-merge
 * the recorded sha exists in no ref at all, and the banner kept reporting it —
 * `3 commit(s) bypassed pre-commit hook` for three commits that never landed. A
 * warning that cannot go down is a warning nobody reads.
 *
 * The rule these tests pin: an entry is dropped only when it can be DISPROVED — the
 * object is present and no ref contains it. An entry that cannot be resolved at all
 * (log copied between clones, object gc'd, not a git repo) stays counted, because a
 * bypass we cannot check is not a bypass we can dismiss.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  parseSkippedCommits,
  partitionSkippedCommits,
  gitReachabilityProbe,
  type ReachabilityProbe,
  CREATING_REPLAY_MESSAGE as CREATING_REPLAY_MESSAGE_FOR_TEST,
} from "./skipped-commits.js";
import { SKIPPED_COMMITS_LOG } from "./hooks.js";

const exec = promisify(execFile);
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

const A = "a".repeat(40);
const B = "b".repeat(40);

function entry(sha: string, reason = "sentinel-missing") {
  return { timestamp: "2026-08-04T10:00:00Z", sha, reason };
}

/** A probe answering from explicit sets — no git, so the rule is what is tested. */
function probeFrom(
  resolvable: string[],
  contained: string[],
  replayed: string[] = [],
): ReachabilityProbe {
  return {
    resolves: (sha) => resolvable.includes(sha),
    containedByAnyRef: (sha) => contained.includes(sha),
    createdByReplay: (sha) => replayed.includes(sha),
  };
}

describe("parseSkippedCommits", () => {
  it("keeps well-formed entries in log order and drops the rest", () => {
    const content = [
      JSON.stringify(entry(A)),
      "{ not json",
      "",
      JSON.stringify(entry(B, "sentinel-stale")),
      JSON.stringify({ timestamp: "2026-08-04T10:00:00Z", reason: "no-sha" }),
    ].join("\n");

    const entries = parseSkippedCommits(content);

    assert.deepEqual(
      entries.map((e) => [e.sha, e.reason]),
      [
        [A, "sentinel-missing"],
        [B, "sentinel-stale"],
      ],
      "a malformed line must not shift or drop the entries around it",
    );
  });
});

describe("partitionSkippedCommits", () => {
  it("counts a commit some ref still contains", () => {
    const { live, orphaned } = partitionSkippedCommits([entry(A)], probeFrom([A], [A]));
    assert.deepEqual(
      live.map((e) => e.sha),
      [A],
    );
    assert.deepEqual(orphaned, []);
  });

  it("drops a commit that resolves but no ref contains — the squash-merge case", () => {
    // This is the whole bug: the merge kept the change and discarded the commit, so the
    // log entry describes a sha that is in no branch, tag or remote ref.
    const { live, orphaned } = partitionSkippedCommits([entry(A)], probeFrom([A], []));
    assert.deepEqual(live, [], "an entry no ref contains is not a live finding");
    assert.deepEqual(
      orphaned.map((e) => e.sha),
      [A],
    );
  });

  it("keeps a commit that cannot be resolved at all — fail closed", () => {
    // Unknown object: a log carried between clones, or one gc'd away. Nothing here
    // disproves the bypass, and a security banner must not go quiet on I-don't-know.
    const { live, orphaned } = partitionSkippedCommits([entry(A)], probeFrom([], []));
    assert.deepEqual(
      live.map((e) => e.sha),
      [A],
      "unverifiable must count as live, not as pruned",
    );
    assert.deepEqual(orphaned, []);
  });

  it("splits a mixed log instead of taking the first answer for all of it", () => {
    const { live, orphaned } = partitionSkippedCommits(
      [entry(A), entry(B)],
      probeFrom([A, B], [B]),
    );
    assert.deepEqual(
      [live.map((e) => e.sha), orphaned.map((e) => e.sha)],
      [[B], [A]],
      "each entry is judged on its own sha",
    );
  });
});

describe("gitReachabilityProbe — against real git", () => {
  it("separates a squashed-away commit from one main still contains", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kit-skipped-git-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      git("commit", "-q", "--allow-empty", "-m", "on main");
      const onMain = git("rev-parse", "HEAD");
      git("checkout", "-q", "-b", "feature");
      git("commit", "-q", "--allow-empty", "-m", "on a branch that gets deleted");
      const orphan = git("rev-parse", "HEAD");
      git("checkout", "-q", "main");
      // The squash-merge shape: the work is gone from every ref, the object is still here.
      git("branch", "-q", "-D", "feature");

      const probe = gitReachabilityProbe(dir);

      assert.equal(probe.resolves(orphan), true, "the object is still in the object store");
      assert.equal(probe.containedByAnyRef(orphan), false, "but no ref reaches it any more");
      assert.equal(probe.containedByAnyRef(onMain), true, "main's own commit is still reachable");

      const { live, orphaned } = partitionSkippedCommits(
        [entry(orphan), entry(onMain)],
        gitReachabilityProbe(dir),
      );
      assert.deepEqual([live.map((e) => e.sha), orphaned.map((e) => e.sha)], [[onMain], [orphan]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports every sha as unresolved outside a git repo — so nothing gets pruned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kit-skipped-nogit-"));
    try {
      const probe = gitReachabilityProbe(dir);
      assert.equal(probe.resolves(A), false);
      assert.equal(probe.containedByAnyRef(A), false);
      const { live } = partitionSkippedCommits([entry(A)], probe);
      assert.equal(live.length, 1, "no git means no verdict, and no verdict means keep it");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the CLI banner reflects the partition", () => {
  async function runVersion(cwd: string) {
    const { stderr } = await exec(process.execPath, [CLI_PATH, "--version"], {
      cwd,
      env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "0" },
      timeout: 60_000,
    });
    return stderr ?? "";
  }

  async function repoWithLog(shas: string[]): Promise<{ dir: string; onMain: string }> {
    const dir = await mkdtemp(join(tmpdir(), "kit-skipped-cli-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "-q", "--allow-empty", "-m", "on main");
    const onMain = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", "feature");
    git("commit", "-q", "--allow-empty", "-m", "squashed away");
    const orphan = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    git("branch", "-q", "-D", "feature");
    const resolved = shas.map((s) => (s === "ORPHAN" ? orphan : s === "MAIN" ? onMain : s));
    await writeFile(
      join(dir, SKIPPED_COMMITS_LOG),
      resolved.map((s) => JSON.stringify(entry(s))).join("\n") + "\n",
      "utf-8",
    );
    return { dir, onMain };
  }

  it("says nothing when every entry was squashed away", async () => {
    const { dir } = await repoWithLog(["ORPHAN"]);
    try {
      const stderr = await runVersion(dir);
      assert.doesNotMatch(
        stderr,
        /bypassed pre-commit hook/,
        `a log of only orphaned entries must produce no banner, got: ${stderr}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("counts only the live entries, and says how many it set aside", async () => {
    const { dir } = await repoWithLog(["ORPHAN", "MAIN"]);
    try {
      const stderr = await runVersion(dir);
      assert.match(
        stderr,
        /1 commit\(s\) bypassed pre-commit hook/,
        `the count must be the live one, not the line count, got: ${stderr}`,
      );
      assert.match(
        stderr,
        /1 earlier entr/,
        `the set-aside entries are stated rather than silently dropped, got: ${stderr}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still warns about a sha it cannot resolve", async () => {
    const { dir } = await repoWithLog([A]);
    try {
      const stderr = await runVersion(dir);
      assert.match(
        stderr,
        /1 commit\(s\) bypassed pre-commit hook/,
        `an unverifiable entry must keep the banner up, got: ${stderr}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A rebase is not a bypass.
 *
 * Every `git rebase` replays commits without running pre-commit — git runs post-commit for each
 * one, the sentinel is absent, and the detector recorded "sentinel-missing". Measured: four false
 * positives from one day of rebasing branches, on commits whose pre-commit hook HAD run, on the
 * original. A false positive in a security banner is worse than no banner: it teaches the operator
 * to skip the line, and then the real `--no-verify` scrolls past unread.
 *
 * The classification has two sources, and the second one is what fixes a log that already has
 * false entries in it: the hook now writes `replayed` when it can see the rebase state, and the
 * reflog can still prove it for lines written before that fix.
 *
 * The negative case below is the one that must never regress: `rebase (finish)` names the branch
 * tip AFTER a rebase, so matching it would excuse a genuine `--no-verify` commit that happened to
 * be that tip — turning a false positive into a false negative, in the wrong direction.
 */
describe("a replayed commit is not a bypass", () => {
  const C = "c".repeat(40);

  it("sets aside an entry the hook already recorded as a replay", () => {
    const { live, replayed } = partitionSkippedCommits(
      [entry(A, "replayed"), entry(B)],
      probeFrom([A, B], [A, B]),
    );
    assert.deepEqual(
      live.map((e) => e.sha),
      [B],
      "only the genuine bypass may be counted",
    );
    assert.deepEqual(
      replayed.map((e) => e.sha),
      [A],
    );
  });

  it("sets aside an older entry the reflog can still prove was replayed", () => {
    // Written before the hook knew about rebases: reason is the old one, and only the reflog
    // distinguishes it.
    const { live, replayed } = partitionSkippedCommits(
      [entry(A), entry(B)],
      probeFrom([A, B], [A, B], [A]),
    );
    assert.deepEqual(
      live.map((e) => e.sha),
      [B],
    );
    assert.deepEqual(
      replayed.map((e) => e.sha),
      [A],
    );
  });

  it("keeps counting a bypass the reflog cannot excuse", () => {
    const { live, replayed, orphaned } = partitionSkippedCommits(
      [entry(C)],
      probeFrom([C], [C], []),
    );
    assert.deepEqual(
      live.map((e) => e.sha),
      [C],
    );
    assert.equal(replayed.length, 0);
    assert.equal(orphaned.length, 0);
  });

  it("only messages that CREATE a commit count as a replay", () => {
    // The regex lives in the module; this asserts the property through the git-backed probe's
    // contract by way of the documented list. `rebase (finish)` and `revert` must not qualify.
    const creating = [
      "rebase (pick): add thing",
      "rebase -i (squash): fold",
      "rebase (fixup): tidy",
      "rebase (reword): message",
      "cherry-pick: port fix",
      "am: apply patch",
    ];
    const notCreating = [
      "rebase (finish): returning to refs/heads/feature",
      "rebase (start): checkout main",
      "checkout: moving from main to feature",
      "commit: ordinary work",
      "commit (amend): fixed",
      "revert: undo a thing",
      "merge main: Fast-forward",
    ];
    for (const m of creating) assert.match(m, CREATING_REPLAY_MESSAGE_FOR_TEST, m);
    for (const m of notCreating) assert.doesNotMatch(m, CREATING_REPLAY_MESSAGE_FOR_TEST, m);
  });
});
