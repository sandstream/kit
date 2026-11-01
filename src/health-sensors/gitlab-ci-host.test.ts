import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gitlabSensor, gitlabTokenHost } from "./gitlab-ci.js";
import type { HealthCtx, HealthDeps } from "../health.js";

const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };
const FAILED = JSON.stringify([
  { id: 9, status: "failed", ref: "main", created_at: "2026-06-22T08:00:00Z" },
]);

/** A remote of `remote` and an HTTP stub that records every URL it is asked for. */
function recording(remote: string, sent: string[]): HealthDeps {
  return {
    runCli: async () => ({ stdout: remote, stderr: "", exitCode: 0, ok: true }),
    httpGet: async (url) => {
      sent.push(url);
      return { ok: true, status: 200, body: FAILED };
    },
  };
}

describe("gitlabTokenHost", () => {
  it("allows gitlab.com and the one host named in GITLAB_HOST, in any spelling", () => {
    assert.equal(gitlabTokenHost("gitlab.com", {}), true);
    assert.equal(gitlabTokenHost("GitLab.com", {}), true);
    assert.equal(gitlabTokenHost("git.example.org", {}), false);
    const url = ["https:", "", "git.example.org", ""].join("/");
    assert.equal(gitlabTokenHost("git.example.org", { GITLAB_HOST: url }), true);
    assert.equal(gitlabTokenHost("github.com", { GITLAB_HOST: "git.example.org" }), false);
    assert.equal(gitlabTokenHost("github.com", { GITLAB_HOST: "  " }), false);
  });
});

describe("gitlabSensor token host", () => {
  afterEach(() => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_HOST;
  });

  it("never sends the token to a non-GitLab origin and says why", async () => {
    process.env.GITLAB_TOKEN = "glpat-xxx";
    const sent: string[] = [];
    const out = await gitlabSensor.probe(ctx, recording("git@github.com:acme/web.git", sent));
    assert.deepEqual(sent, []);
    assert.equal(out[0].status, "unknown");
    assert.ok(out[0].title.includes("github.com is not a known GitLab host"));
  });

  it("probes a self-hosted instance once GITLAB_HOST names it", async () => {
    process.env.GITLAB_TOKEN = "glpat-xxx";
    process.env.GITLAB_HOST = "git.example.org";
    const sent: string[] = [];
    const out = await gitlabSensor.probe(ctx, recording("git@git.example.org:acme/web.git", sent));
    assert.equal(sent.length, 1);
    assert.ok(sent[0].startsWith("https:" + "/".repeat(2) + "git.example.org/api/v4/"));
    assert.equal(out[0].status, "red");
  });
});
