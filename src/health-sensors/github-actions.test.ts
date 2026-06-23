import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitHubRuns,
  failingWorkflows,
  activeWorkflowNames,
  githubActionsSensor,
} from "./github-actions.js";
import type { HealthCtx, HealthDeps } from "../health.js";

const runs = JSON.stringify([
  {
    name: "CI",
    status: "completed",
    conclusion: "failure",
    createdAt: "2026-06-21T06:50:00Z",
    databaseId: 9,
  },
  {
    name: "CI",
    status: "completed",
    conclusion: "success",
    createdAt: "2026-06-20T06:50:00Z",
    databaseId: 8,
  },
  {
    name: "Security",
    status: "completed",
    conclusion: "success",
    createdAt: "2026-06-21T05:00:00Z",
    databaseId: 7,
  },
]);

function deps(over: Record<string, { stdout: string; ok: boolean }> = {}): HealthDeps {
  return {
    runCli: async (cmd, args) => {
      const key = `${cmd} ${args[0]}`;
      const r = over[key];
      if (r) return { stdout: r.stdout, stderr: "", exitCode: r.ok ? 0 : 1, ok: r.ok };
      return { stdout: "", stderr: "", exitCode: 0, ok: true };
    },
    httpGet: async () => ({ ok: true, status: 200, body: "" }),
  };
}
const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };

describe("parseGitHubRuns / failingWorkflows", () => {
  it("keeps only the latest completed run per workflow and flags failures", () => {
    const parsed = parseGitHubRuns(runs);
    assert.equal(parsed.length, 3);
    const failing = failingWorkflows(parsed);
    assert.deepEqual(
      failing.map((f) => f.name),
      ["CI"],
    ); // newest CI is failure; Security is green
  });

  it("returns [] when the JSON is empty", () => {
    assert.deepEqual(failingWorkflows(parseGitHubRuns("[]")), []);
  });

  it("excludes workflows not in the active set when one is provided", () => {
    const parsed = parseGitHubRuns(
      JSON.stringify([
        {
          name: "CI",
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-06-21T06:50:00Z",
          databaseId: 9,
        },
        {
          name: "Crons",
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-06-14T06:50:00Z",
          databaseId: 1,
        },
      ]),
    );
    const active = new Set(["CI"]); // Crons is disabled
    assert.deepEqual(
      failingWorkflows(parsed, active).map((f) => f.name),
      ["CI"],
    );
  });

  it("does not filter when the active set is empty/unknown (fail open to reporting)", () => {
    const parsed = parseGitHubRuns(
      JSON.stringify([
        {
          name: "CI",
          status: "completed",
          conclusion: "failure",
          createdAt: "2026-06-21T06:50:00Z",
          databaseId: 9,
        },
      ]),
    );
    assert.deepEqual(
      failingWorkflows(parsed, new Set()).map((f) => f.name),
      ["CI"],
    );
  });
});

describe("activeWorkflowNames", () => {
  it("returns only workflows whose state is active", () => {
    const json = JSON.stringify([
      { name: "CI", state: "active" },
      { name: "Crons", state: "disabled_manually" },
      { name: "Old", state: "disabled_inactivity" },
    ]);
    const s = activeWorkflowNames(json);
    assert.ok(s.has("CI"));
    assert.equal(s.has("Crons"), false);
    assert.equal(s.has("Old"), false);
  });

  it("returns an empty set on garbage input", () => {
    assert.equal(activeWorkflowNames("not json").size, 0);
  });
});

describe("githubActionsSensor.probe", () => {
  it("emits one red finding per failing workflow", async () => {
    const out = await githubActionsSensor.probe(
      ctx,
      deps({
        "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/webapp" }), ok: true },
        "gh run": { stdout: runs, ok: true },
      }),
    );
    const red = out.filter((f) => f.status === "red");
    assert.equal(red.length, 1);
    assert.equal(red[0].sensor, "github-actions");
    assert.equal(red[0].source, "acme/webapp");
    assert.equal(red[0].suggestedClass, "code");
    assert.match(red[0].title, /CI/);
  });

  it("does not flag a disabled workflow whose last run failed", async () => {
    const mixed = JSON.stringify([
      {
        name: "CI",
        status: "completed",
        conclusion: "failure",
        createdAt: "2026-06-21T06:50:00Z",
        databaseId: 9,
      },
      {
        name: "Crons",
        status: "completed",
        conclusion: "failure",
        createdAt: "2026-06-14T06:50:00Z",
        databaseId: 1,
      },
    ]);
    const workflows = JSON.stringify([
      { name: "CI", state: "active" },
      { name: "Crons", state: "disabled_manually" },
    ]);
    const out = await githubActionsSensor.probe(
      ctx,
      deps({
        "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/webapp" }), ok: true },
        "gh workflow": { stdout: workflows, ok: true },
        "gh run": { stdout: mixed, ok: true },
      }),
    );
    const red = out.filter((f) => f.status === "red");
    assert.deepEqual(
      red.map((f) => f.title),
      ["GitHub Actions workflow failing: CI"],
    );
  });

  it("emits a single green finding when nothing fails", async () => {
    const allGreen = JSON.stringify([
      {
        name: "CI",
        status: "completed",
        conclusion: "success",
        createdAt: "2026-06-21T06:50:00Z",
        databaseId: 9,
      },
    ]);
    const out = await githubActionsSensor.probe(
      ctx,
      deps({
        "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/webapp" }), ok: true },
        "gh run": { stdout: allGreen, ok: true },
      }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "green");
  });

  it("returns unknown when gh is not authed", async () => {
    const out = await githubActionsSensor.probe(
      ctx,
      deps({
        "gh repo": { stdout: "", ok: false },
      }),
    );
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
