import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dependabotPrFindings,
  githubDependabotSensor,
  parseDependabotPrs,
} from "./github-dependabot.js";
import type { HealthCtx, HealthDeps } from "../health.js";

const ctx: HealthCtx = { cwd: "/tmp/repo", config: {}, gitRemote: true, githubDependabot: true };

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

describe("parseDependabotPrs / dependabotPrFindings", () => {
  it("turns failing Dependabot PR checks into red health findings", () => {
    const prs = parseDependabotPrs(
      JSON.stringify([
        {
          number: 12,
          title: "Bump x",
          url: "https://github.com/acme/web/pull/12",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [
            { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "FAILURE" },
          ],
        },
      ]),
    );
    const out = dependabotPrFindings("acme/web", prs);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "red");
    assert.match(out[0].title, /checks failing/);
  });

  it("turns action-required Dependabot PR checks into red health findings", () => {
    const prs = parseDependabotPrs(
      JSON.stringify([
        {
          number: 15,
          title: "Bump w",
          url: "https://github.com/acme/web/pull/15",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              name: "CI",
              status: "COMPLETED",
              conclusion: "ACTION_REQUIRED",
            },
          ],
        },
      ]),
    );
    const out = dependabotPrFindings("acme/web", prs);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "red");
    assert.match(out[0].title, /checks failing/);
  });

  it("turns pending Dependabot PR checks into unknown health findings", () => {
    const prs = parseDependabotPrs(
      JSON.stringify([
        {
          number: 13,
          title: "Bump y",
          url: "https://github.com/acme/web/pull/13",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ __typename: "CheckRun", name: "CI", status: "IN_PROGRESS" }],
        },
      ]),
    );
    const out = dependabotPrFindings("acme/web", prs);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /checks pending/);
  });

  it("turns a ready open Dependabot PR into an action item", () => {
    const prs = parseDependabotPrs(
      JSON.stringify([
        {
          number: 14,
          title: "Bump z",
          url: "https://github.com/acme/web/pull/14",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [
            { __typename: "CheckRun", name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        },
      ]),
    );
    const out = dependabotPrFindings("acme/web", prs);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "red");
    assert.equal(out[0].severity, "low");
    assert.match(out[0].title, /ready for review/);
  });
});

describe("githubDependabotSensor.probe", () => {
  it("is green when no Dependabot PRs are open", async () => {
    const out = await githubDependabotSensor.probe(
      ctx,
      deps({
        "gh repo": { stdout: JSON.stringify({ nameWithOwner: "acme/web" }), ok: true },
        "gh pr": { stdout: "[]", ok: true },
      }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "green");
  });
});
