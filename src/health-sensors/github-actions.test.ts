import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitHubRuns,
  failingWorkflows,
  githubActionsSensor,
} from "./github-actions.js";
import type { HealthCtx, HealthDeps } from "../health.js";

const runs = JSON.stringify([
  { name: "CI", status: "completed", conclusion: "failure", createdAt: "2026-06-21T06:50:00Z", databaseId: 9 },
  { name: "CI", status: "completed", conclusion: "success", createdAt: "2026-06-20T06:50:00Z", databaseId: 8 },
  { name: "Security", status: "completed", conclusion: "success", createdAt: "2026-06-21T05:00:00Z", databaseId: 7 },
]);

function deps(over: Record<string, { stdout: string; ok: boolean }> = {}): HealthDeps {
  return {
    runCli: async (cmd, args) => {
      const key = `${cmd} ${args[0]}`;
      const r = over[key];
      if (r) return { stdout: r.stdout, stderr: "", exitCode: r.ok ? 0 : 1, ok: r.ok };
      return { stdout: "", stderr: "", exitCode: 0, ok: true };
    },
  };
}
const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };

describe("parseGitHubRuns / failingWorkflows", () => {
  it("keeps only the latest completed run per workflow and flags failures", () => {
    const parsed = parseGitHubRuns(runs);
    assert.equal(parsed.length, 3);
    const failing = failingWorkflows(parsed);
    assert.deepEqual(failing.map((f) => f.name), ["CI"]); // newest CI is failure; Security is green
  });

  it("returns [] when the JSON is empty", () => {
    assert.deepEqual(failingWorkflows(parseGitHubRuns("[]")), []);
  });
});

describe("githubActionsSensor.probe", () => {
  it("emits one red finding per failing workflow", async () => {
    const out = await githubActionsSensor.probe(ctx, deps({
      "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/webapp" }), ok: true },
      "gh run": { stdout: runs, ok: true },
    }));
    const red = out.filter((f) => f.status === "red");
    assert.equal(red.length, 1);
    assert.equal(red[0].sensor, "github-actions");
    assert.equal(red[0].source, "acme/webapp");
    assert.equal(red[0].suggestedClass, "code");
    assert.match(red[0].title, /CI/);
  });

  it("emits a single green finding when nothing fails", async () => {
    const allGreen = JSON.stringify([
      { name: "CI", status: "completed", conclusion: "success", createdAt: "2026-06-21T06:50:00Z", databaseId: 9 },
    ]);
    const out = await githubActionsSensor.probe(ctx, deps({
      "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/webapp" }), ok: true },
      "gh run": { stdout: allGreen, ok: true },
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "green");
  });

  it("returns unknown when gh is not authed", async () => {
    const out = await githubActionsSensor.probe(ctx, deps({
      "gh repo": { stdout: "", ok: false },
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "unknown");
  });

  it("returns unknown on context/repo owner mismatch", async () => {
    const out = await githubActionsSensor.probe(
      { cwd: "/tmp/repo", config: { context: { github: { org: "otherorg" } } } },
      deps({ "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/webapp" }), ok: true } }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].detail ?? "", /otherorg/);
  });
});
