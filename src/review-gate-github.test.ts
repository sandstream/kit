/**
 * The GitHub reads behind `kit review gate`, against a stubbed REST API: explicit paging, the rule
 * file's absence, and every failure recorded as unread instead of thrown.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gitHubReader, readGate } from "./review-gate-github.js";
import { DEFAULT_PROTECTED_PATH_RULES } from "./review-protected-paths.js";
import { fakeGitHub, HEAD, MAIN, run } from "./review-gate.test-support.js";

const files = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ filename: `docs/f${i}.md`, additions: 1, deletions: 1 }));

describe("review gate GitHub reads: paging", () => {
  it("pages files and check runs with per_page=100&page=N until a short page", async () => {
    const runs = Array.from({ length: 150 }, (_, i) => run(`c${i}`, "success"));
    const gh = fakeGitHub({ files: files(230), runs });
    const reads = await readGate(gitHubReader(undefined, gh.fetcher), "o/r", 7);
    assert.equal(reads.fileCount, 230);
    assert.equal(reads.changedLines, 460);
    assert.equal(reads.checks?.total, 150);
    const pages = gh.calls.map((c) => c.url).filter((u) => u.includes("/files?"));
    assert.deepEqual(
      pages.map((u) => new URL(u).search),
      ["?per_page=100&page=1", "?per_page=100&page=2", "?per_page=100&page=3"],
    );
    assert.equal(gh.calls.filter((c) => c.url.includes(`${HEAD}/check-runs?`)).length, 2);
  });

  it("marks a file list that never ends as truncated", async () => {
    const gh = fakeGitHub({ files: files(3000) });
    const reads = await readGate(gitHubReader(undefined, gh.fetcher), "o/r", 7);
    assert.equal(reads.truncated, true);
  });

  it("keeps a renamed file's old path, so moving a protected file out is still seen", async () => {
    const renamed = [
      { filename: "x.ts", previous_filename: "src/audit.ts", additions: 0, deletions: 0 },
    ];
    const reads = await readGate(
      gitHubReader(undefined, fakeGitHub({ files: renamed }).fetcher),
      "o/r",
      7,
    );
    assert.deepEqual(reads.paths, ["x.ts", "src/audit.ts"]);
  });
});

describe("review gate GitHub reads: rules, main and failures", () => {
  it("reads the rule file at the default branch's head commit, or falls back to kit's", async () => {
    const custom = JSON.stringify({
      release: { exact: ["R"], prefix: [] },
      github: { exact: [], prefix: [] },
      secrets: { exact: [], prefix: [] },
      permissions: { exact: [], prefix: [] },
    });
    const gh = fakeGitHub({ rules: custom, mainRuns: [run("build-and-test", "failure")] });
    const reads = await readGate(gitHubReader(undefined, gh.fetcher), "o/r", 7);
    assert.equal(reads.rulesSource, "repo");
    assert.deepEqual(reads.rules.release.exact, ["R"]);
    assert.ok(gh.calls.some((c) => c.url.endsWith(`kit-protected-paths.json?ref=${MAIN}`)));
    assert.deepEqual(reads.main, { branch: "main", sha: MAIN, red: ["build-and-test"] });
    const none = await readGate(
      gitHubReader(undefined, fakeGitHub({ rules: null }).fetcher),
      "o/r",
      7,
    );
    assert.equal(none.rulesSource, "default");
    assert.equal(none.rules, DEFAULT_PROTECTED_PATH_RULES);
    assert.deepEqual(none.unread, []);
  });

  it("records a failed read, an unparsable rule file and a moved head as unread", async () => {
    const cases = [
      { fail: { match: `${HEAD}/check-runs`, status: 502 } },
      { fail: { match: "/repos/o/r/pulls/7/files", status: 500 } },
      { rules: "{not json" },
      { headAfter: "b".repeat(40) },
    ];
    for (const fake of cases) {
      const reads = await readGate(gitHubReader(undefined, fakeGitHub(fake).fetcher), "o/r", 7);
      assert.equal(reads.unread.length, 1, JSON.stringify(fake));
    }
    const pull = await readGate(
      gitHubReader(undefined, fakeGitHub({ fail: { match: "/pulls/7", status: 403 } }).fetcher),
      "o/r",
      7,
    );
    assert.equal(pull.pull, null);
    assert.match(pull.unread[0]!, /could not read the pull request: .*HTTP 403/);
  });

  it("sends a token only as a bearer header, and no header without one", async () => {
    const gh = fakeGitHub();
    await readGate(gitHubReader("test-token-not-a-secret-7f3a", gh.fetcher), "o/r", 7);
    assert.ok(
      gh.calls.every((c) => c.headers.Authorization === "Bearer test-token-not-a-secret-7f3a"),
    );
    assert.ok(gh.calls.every((c) => !c.url.includes("not-a-secret")));
    const anon = fakeGitHub();
    await readGate(gitHubReader(undefined, anon.fetcher), "o/r", 7);
    assert.ok(anon.calls.every((c) => !("Authorization" in c.headers)));
  });
});
