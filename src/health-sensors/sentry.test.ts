import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseSentryIssues, sentrySensor } from "./sentry.js";
import type { HealthCtx, HealthDeps, HttpResponse } from "../health.js";

const issues = JSON.stringify([
  { id: "1", title: "TypeError: x is not a function", level: "error", status: "unresolved" },
]);

function deps(over: { http?: HttpResponse } = {}): HealthDeps {
  return {
    runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }),
    httpGet: async () => over.http ?? { ok: true, status: 200, body: issues },
  };
}
const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };

describe("parseSentryIssues", () => {
  it("parses an issue array; [] on garbage", () => {
    assert.equal(parseSentryIssues(issues).length, 1);
    assert.deepEqual(parseSentryIssues("nope"), []);
  });
});

describe("sentrySensor.probe", () => {
  afterEach(() => {
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_ORG;
    delete process.env.SENTRY_PROJECT;
    delete process.env.SENTRY_URL;
  });

  function setEnv() {
    process.env.SENTRY_AUTH_TOKEN = "t";
    process.env.SENTRY_ORG = "acme";
    process.env.SENTRY_PROJECT = "web";
  }

  it("emits red when there are new unresolved issues", async () => {
    setEnv();
    const out = await sentrySensor.probe(ctx, deps());
    assert.equal(out[0].status, "red");
    assert.equal(out[0].source, "acme/web");
    assert.match(out[0].title, /1 new unresolved/);
  });

  it("emits green when none", async () => {
    setEnv();
    const out = await sentrySensor.probe(
      ctx,
      deps({ http: { ok: true, status: 200, body: "[]" } }),
    );
    assert.equal(out[0].status, "green");
  });

  it("is unknown (not green) when token/org/project not all set", async () => {
    const out = await sentrySensor.probe(ctx, deps());
    assert.equal(out[0].status, "unknown");
  });

  it("is unknown on a non-OK API response", async () => {
    setEnv();
    const out = await sentrySensor.probe(ctx, deps({ http: { ok: false, status: 401, body: "" } }));
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /401/);
  });
});
