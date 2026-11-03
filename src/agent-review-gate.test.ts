/**
 * scripts/agent-review-gate.mjs approves a pull request's commit only when every check passed,
 * no file is in a protected class and the change is under the size limit. Everything else is a
 * comment that names the reason. The decision is pure and pinned here.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Run {
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string;
}
interface ChecksState {
  state: string;
  failed: string[];
  total: number;
}
interface Gate {
  headIsStill(
    repo: string,
    number: number,
    sha: string,
    token: string,
    read?: (path: string, token: string) => Promise<{ head?: { sha?: string }; state?: string }>,
  ): Promise<boolean>;
  MAX_CHANGED_LINES: number;
  latestChecks(runs: Run[]): Run[];
  checksState(runs: Run[]): ChecksState;
  decide(input: {
    sha: string;
    checks: ChecksState;
    protectedPaths: { path: string; classes: string[] }[];
    changedLines: number;
    fileCount: number;
    truncated: boolean;
  }): { event: string; body: string };
}

const load = async () =>
  (await import(pathToFileURL(join(REPO_ROOT, "scripts", "agent-review-gate.mjs")).href)) as Gate;

const SHA = "a".repeat(40);
const run = (name: string, conclusion: string | null, status = "completed", at = "1"): Run => ({
  name,
  status,
  conclusion,
  started_at: at,
});
const base = { sha: SHA, protectedPaths: [], changedLines: 10, fileCount: 2, truncated: false };

describe("agent review gate: check state", () => {
  it("is pending while any check runs, or before any check exists", async () => {
    const { checksState } = await load();
    assert.equal(checksState([]).state, "pending");
    assert.equal(
      checksState([run("a", "success"), run("b", null, "in_progress")]).state,
      "pending",
    );
  });

  it("counts a re-run's newer result, not the failure it replaced", async () => {
    const { checksState } = await load();
    const runs = [
      run("build", "failure", "completed", "1"),
      run("build", "success", "completed", "2"),
    ];
    assert.deepEqual(checksState(runs), { state: "green", failed: [], total: 1 });
  });

  it("names every check that did not pass; skipped and neutral pass", async () => {
    const { checksState } = await load();
    const runs = [
      run("z", "failure"),
      run("a", "cancelled"),
      run("s", "skipped"),
      run("n", "neutral"),
    ];
    assert.deepEqual(checksState(runs), { state: "failed", failed: ["a", "z"], total: 4 });
  });
});

describe("agent review gate: decision", () => {
  const green = { state: "green", failed: [], total: 5 };

  it("approves only when checks pass, nothing is protected and the change is small", async () => {
    const { decide } = await load();
    const d = decide({ ...base, checks: green });
    assert.equal(d.event, "APPROVE");
    assert.match(d.body, /gates passed/);
    assert.match(d.body, /does not judge what the change is for/);
  });

  it("never approves a protected path, and names the class and the file", async () => {
    const { decide } = await load();
    const d = decide({
      ...base,
      checks: green,
      protectedPaths: [{ path: ".github/workflows/ci.yml", classes: ["github"] }],
    });
    assert.equal(d.event, "COMMENT");
    assert.match(d.body, /protected paths \(github\).*`\.github\/workflows\/ci\.yml`/);
  });

  it("never approves failed checks, a truncated file list or an oversized change", async () => {
    const { decide, MAX_CHANGED_LINES } = await load();
    const failed = decide({ ...base, checks: { state: "failed", failed: ["CI"], total: 3 } });
    assert.equal(failed.event, "COMMENT");
    assert.match(failed.body, /checks did not pass: CI/);
    assert.equal(decide({ ...base, checks: green, truncated: true }).event, "COMMENT");
    const big = decide({ ...base, checks: green, changedLines: MAX_CHANGED_LINES + 1 });
    assert.equal(big.event, "COMMENT");
  });

  it("marks every review so a repeat run can recognise its own decision", async () => {
    const { decide } = await load();
    assert.ok(decide({ ...base, checks: green }).body.startsWith("<!-- kit-review-gate -->"));
  });
});

describe("agent review gate: the reviewed commit is still the head", () => {
  const SHA2 = "b".repeat(40);
  const reads =
    (head: string, state = "open") =>
    async () => ({ head: { sha: head }, state });

  it("is true only while the pull request is open and its head is the reviewed commit", async () => {
    const gate = await load();
    assert.equal(await gate.headIsStill("o/r", 1, SHA, "t", reads(SHA)), true);
    assert.equal(await gate.headIsStill("o/r", 1, SHA, "t", reads(SHA2)), false);
    assert.equal(await gate.headIsStill("o/r", 1, SHA, "t", reads(SHA, "closed")), false);
  });

  it("is false when the read fails, so a failure never approves", async () => {
    const gate = await load();
    const broken = async () => {
      throw new Error("HTTP 502");
    };
    assert.equal(await gate.headIsStill("o/r", 1, SHA, "t", broken), false);
  });

  it("is checked after the files and the diff were read and before the review is posted", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts", "agent-review-gate.mjs"), "utf8");
    const body = src.slice(src.indexOf("async function decideAll"));
    const files = body.indexOf("/files`");
    const model = body.indexOf("withModel(repo, pull");
    const post = body.indexOf("await post(repo");
    const checks = [...body.matchAll(/headIsStill\(/g)].map((m) => m.index ?? -1);
    assert.ok(
      checks.some((i) => i > files && i < model),
      "a check between the files and the model review",
    );
    assert.ok(
      checks.some((i) => i > model && i < post),
      "a check between the model review and the post",
    );
  });
});
