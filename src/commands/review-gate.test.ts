/**
 * `kit review gate --pr <n>` against a stubbed GitHub and a stubbed git: one test per verdict, the
 * exit code each one sets, the audit row, and a token that never reaches the output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdReviewGate, type ReviewGateDeps } from "./review-gate.js";
import {
  fakeGit,
  fakeGitHub,
  HEAD,
  hubSources,
  run,
  type FakeGitHub,
} from "../review-gate.test-support.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const TOKEN = "test-token-not-a-secret-7f3a";

interface Outcome {
  ok: boolean;
  code: number | string | null | undefined;
  out: string;
  json: Record<string, unknown>;
  dir: string;
}

async function gate(
  t: { after(fn: () => void): void },
  fake: FakeGitHub,
  extra: Partial<ReviewGateDeps> = {},
  argv = ["node", "kit", "review", "gate", "--pr", "7", "--repo", "o/r"],
): Promise<Outcome> {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-gate-cmd-"));
  t.after(() => rmTemp(dir));
  const lines: string[] = [];
  const deps: ReviewGateDeps = {
    fetcher: fakeGitHub(fake).fetcher,
    env: { GH_TOKEN: TOKEN },
    cwd: dir,
    originRepo: () => "o/r",
    git: fakeGit({ "src/leaf.ts": "export {};\n" }),
    log: (line) => lines.push(line),
    ...extra,
  };
  const saved = process.exitCode;
  const ok = await cmdReviewGate([...argv, "--json"], deps);
  const code = process.exitCode;
  process.exitCode = saved;
  const out = lines.join("\n");
  return { ok, code, out, json: JSON.parse(out) as Record<string, unknown>, dir };
}

const greenRuns = [run("build", "success"), run("lint", "skipped")];
const doc = [{ filename: "docs/x.md", additions: 3, deletions: 1 }];

describe("kit review gate: verdicts and exit codes", () => {
  it("approves when every gate passed, exit 0, and names the head it judged", async (t) => {
    const r = await gate(t, { files: doc, runs: greenRuns });
    assert.equal(r.json.verdict, "approve");
    assert.equal(r.json.head_sha, HEAD);
    assert.deepEqual([r.ok, r.code], [true, 0]);
  });

  it("routes a protected path, a wide module or an oversized change to the owner, exit 3", async (t) => {
    const prot = await gate(t, {
      files: [{ filename: ".github/ci.yml", additions: 1, deletions: 0 }],
      runs: greenRuns,
    });
    const wide = await gate(
      t,
      { files: [{ filename: "src/hub.ts", additions: 1, deletions: 0 }], runs: greenRuns },
      { git: fakeGit(hubSources(20)) },
    );
    const big = await gate(t, {
      files: [{ filename: "a.ts", additions: 1501, deletions: 0 }],
      runs: greenRuns,
    });
    for (const r of [prot, wide, big])
      assert.deepEqual([r.json.verdict, r.code, r.ok], ["owner", 3, false]);
    assert.match(JSON.stringify(wide.json.reasons), /src\/hub\.ts` \(20 importers\)/);
  });

  it("holds on a failed check or a red main, exit 4", async (t) => {
    const failed = await gate(t, { files: doc, runs: [run("build", "failure")] });
    const red = await gate(t, {
      files: doc,
      runs: greenRuns,
      mainRuns: [run("build-and-test", "failure")],
    });
    for (const r of [failed, red]) assert.deepEqual([r.json.verdict, r.code], ["hold", 4]);
  });

  it("waits while checks run, exit 5", async (t) => {
    const r = await gate(t, { files: doc, runs: [run("build", null, "in_progress")] });
    assert.deepEqual([r.json.verdict, r.code], ["pending", 5]);
  });

  it("is incomplete on any read error, never approve, exit 6", async (t) => {
    const reads = await gate(t, {
      files: doc,
      runs: greenRuns,
      fail: { match: "/files", status: 502 },
    });
    const noClone = await gate(
      t,
      { files: doc, runs: greenRuns },
      { originRepo: () => "other/repo" },
    );
    const noCommit = await gate(
      t,
      { files: doc, runs: greenRuns },
      {
        git: () => {
          throw new Error("bad object");
        },
      },
    );
    for (const r of [reads, noClone, noCommit])
      assert.deepEqual([r.json.verdict, r.code], ["incomplete", 6]);
    assert.match(JSON.stringify(noCommit.json.reasons), /git fetch origin main/);
  });
});

describe("kit review gate: output, audit and arguments", () => {
  it("never prints the token, in JSON or in a failure message", async (t) => {
    const ok = await gate(t, { files: doc, runs: greenRuns });
    const bad = await gate(t, { fail: { match: "/pulls/7", status: 401 } });
    for (const r of [ok, bad]) assert.ok(!r.out.includes(TOKEN));
    assert.equal(bad.json.head_sha, null);
    assert.ok(!readFileSync(join(ok.dir, ".kit-audit.jsonl"), "utf8").includes(TOKEN));
  });

  it("says when the default branch has no rule file and kit's built-in paths were used", async (t) => {
    const r = await gate(t, { files: doc, runs: greenRuns, rules: null });
    assert.match(String(r.json.rules), /built-in.*no \.github\/kit-protected-paths\.json/);
  });

  it("appends one audit row: repo, PR, head, verdict, reasons and time", async (t) => {
    const r = await gate(t, { files: doc, runs: [run("build", "failure")] });
    const rows = readFileSync(join(r.dir, ".kit-audit.jsonl"), "utf8").trim().split("\n");
    assert.equal(rows.length, 1);
    const row = JSON.parse(rows[0]!) as { operation: string; metadata: Record<string, unknown> };
    assert.equal(row.operation, "review.gate");
    const { target_repo, pr, head_sha, verdict, reasons, decided_at } = row.metadata;
    assert.deepEqual([target_repo, pr, head_sha, verdict], ["o/r", 7, HEAD, "hold"]);
    assert.match(String(reasons), /checks did not pass: build/);
    assert.ok(!Number.isNaN(Date.parse(String(decided_at))));
  });

  it("refuses a missing or malformed --pr and a malformed --repo with the usage exit code", async () => {
    for (const argv of [
      ["--pr"],
      ["--pr", "0"],
      ["--pr", "7", "--repo", "../x"],
      ["--pr", "7", "--repo", "o/.."],
    ]) {
      const saved = process.exitCode;
      const ok = await cmdReviewGate(["node", "kit", "review", "gate", ...argv], {
        log: () => {},
        fetcher: () => Promise.reject(new Error("a usage error never reaches the network")),
      });
      assert.deepEqual([ok, process.exitCode], [false, 2], argv.join(" "));
      process.exitCode = saved;
    }
  });
});
