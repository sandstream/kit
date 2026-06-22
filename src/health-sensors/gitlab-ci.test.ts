import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseGitlabPipelines, latestFailedPipeline, gitlabSensor } from "./gitlab-ci.js";
import type { HealthCtx, HealthDeps, HttpResponse } from "../health.js";

const pipelines = JSON.stringify([
  { id: 9, status: "failed", ref: "main", created_at: "2026-06-22T08:00:00Z" },
  { id: 8, status: "success", ref: "main", created_at: "2026-06-21T08:00:00Z" },
  { id: 7, status: "running", ref: "feat", created_at: "2026-06-22T09:00:00Z" },
]);

function deps(over: { remoteOk?: boolean; remote?: string; http?: HttpResponse } = {}): HealthDeps {
  return {
    runCli: async (cmd, args) => {
      if (cmd === "git" && args[0] === "remote") {
        const ok = over.remoteOk ?? true;
        return { stdout: over.remote ?? "git@gitlab.com:acme/web.git", stderr: "", exitCode: ok ? 0 : 1, ok };
      }
      return { stdout: "", stderr: "", exitCode: 0, ok: true };
    },
    httpGet: async () => over.http ?? { ok: true, status: 200, body: pipelines },
  };
}
const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };

describe("parseGitlabPipelines / latestFailedPipeline", () => {
  it("flags the most recent TERMINAL pipeline when it failed (ignores running)", () => {
    const f = latestFailedPipeline(parseGitlabPipelines(pipelines));
    assert.equal(f?.id, 9);
  });
  it("returns null when the latest terminal pipeline succeeded", () => {
    const json = JSON.stringify([{ id: 8, status: "success", ref: "main", created_at: "2026-06-21T08:00:00Z" }]);
    assert.equal(latestFailedPipeline(parseGitlabPipelines(json)), null);
  });
  it("returns [] on garbage", () => {
    assert.deepEqual(parseGitlabPipelines("nope"), []);
  });
});

describe("gitlabSensor.probe", () => {
  afterEach(() => {
    delete process.env.GITLAB_TOKEN;
  });

  it("emits red when the latest pipeline failed", async () => {
    process.env.GITLAB_TOKEN = "glpat-xxx";
    const out = await gitlabSensor.probe(ctx, deps());
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "red");
    assert.equal(out[0].source, "gitlab.com/acme/web");
    assert.equal(out[0].suggestedClass, "code");
  });

  it("emits green when the latest terminal pipeline passed", async () => {
    process.env.GITLAB_TOKEN = "glpat-xxx";
    const ok = JSON.stringify([{ id: 8, status: "success", ref: "main", created_at: "2026-06-21T08:00:00Z" }]);
    const out = await gitlabSensor.probe(ctx, deps({ http: { ok: true, status: 200, body: ok } }));
    assert.equal(out[0].status, "green");
  });

  it("is unknown (not green) when GITLAB_TOKEN is missing — no silent gap", async () => {
    const out = await gitlabSensor.probe(ctx, deps());
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /GITLAB_TOKEN/);
  });

  it("is unknown on a non-OK API response", async () => {
    process.env.GITLAB_TOKEN = "glpat-xxx";
    const out = await gitlabSensor.probe(ctx, deps({ http: { ok: false, status: 401, body: "" } }));
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /401/);
  });

  it("is unknown when there is no git remote", async () => {
    process.env.GITLAB_TOKEN = "glpat-xxx";
    const out = await gitlabSensor.probe(ctx, deps({ remoteOk: false }));
    assert.equal(out[0].status, "unknown");
  });
});
