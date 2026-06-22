import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  parseBitbucketPipelines,
  latestFailedBitbucket,
  bitbucketAuthHeader,
  bitbucketSensor,
} from "./bitbucket-pipelines.js";
import type { HealthCtx, HealthDeps, HttpResponse } from "../health.js";

const body = JSON.stringify({
  values: [
    { build_number: 42, state: { name: "COMPLETED", result: { name: "FAILED" } }, target: { ref_name: "main" }, created_on: "2026-06-22T08:00:00Z" },
    { build_number: 41, state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } }, target: { ref_name: "main" }, created_on: "2026-06-21T08:00:00Z" },
    { build_number: 43, state: { name: "IN_PROGRESS" }, target: { ref_name: "feat" }, created_on: "2026-06-22T09:00:00Z" },
  ],
});

function deps(over: { remoteOk?: boolean; remote?: string; http?: HttpResponse } = {}): HealthDeps {
  return {
    runCli: async (cmd, args) => {
      if (cmd === "git" && args[0] === "remote") {
        const ok = over.remoteOk ?? true;
        return { stdout: over.remote ?? "git@bitbucket.org:acme/web.git", stderr: "", exitCode: ok ? 0 : 1, ok };
      }
      return { stdout: "", stderr: "", exitCode: 0, ok: true };
    },
    httpGet: async () => over.http ?? { ok: true, status: 200, body },
  };
}
const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };

describe("parseBitbucketPipelines / latestFailedBitbucket", () => {
  it("flags the most recent COMPLETED pipeline when FAILED (ignores IN_PROGRESS)", () => {
    const f = latestFailedBitbucket(parseBitbucketPipelines(body));
    assert.equal(f?.build_number, 42);
  });
  it("returns null when the latest completed pipeline succeeded", () => {
    const ok = JSON.stringify({ values: [{ build_number: 41, state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } }, created_on: "2026-06-21T08:00:00Z" }] });
    assert.equal(latestFailedBitbucket(parseBitbucketPipelines(ok)), null);
  });
  it("treats STOPPED (cancelled) as not-red", () => {
    const stopped = JSON.stringify({ values: [{ build_number: 40, state: { name: "COMPLETED", result: { name: "STOPPED" } }, created_on: "2026-06-22T08:00:00Z" }] });
    assert.equal(latestFailedBitbucket(parseBitbucketPipelines(stopped)), null);
  });
});

describe("bitbucketAuthHeader", () => {
  it("prefers a bearer token", () => {
    assert.equal(bitbucketAuthHeader({ BITBUCKET_TOKEN: "t" } as NodeJS.ProcessEnv), "Bearer t");
  });
  it("falls back to basic from username + app password", () => {
    const h = bitbucketAuthHeader({ BITBUCKET_USERNAME: "u", BITBUCKET_APP_PASSWORD: "p" } as NodeJS.ProcessEnv);
    assert.equal(h, `Basic ${Buffer.from("u:p").toString("base64")}`);
  });
  it("returns null with no creds", () => {
    assert.equal(bitbucketAuthHeader({} as NodeJS.ProcessEnv), null);
  });
});

describe("bitbucketSensor.probe", () => {
  afterEach(() => {
    delete process.env.BITBUCKET_TOKEN;
    delete process.env.BITBUCKET_USERNAME;
    delete process.env.BITBUCKET_APP_PASSWORD;
  });

  it("emits red when the latest pipeline failed", async () => {
    process.env.BITBUCKET_TOKEN = "bbt";
    const out = await bitbucketSensor.probe(ctx, deps());
    assert.equal(out[0].status, "red");
    assert.equal(out[0].source, "bitbucket.org/acme/web");
    assert.match(out[0].title, /main/);
  });

  it("is unknown (not green) when no credentials — no silent gap", async () => {
    const out = await bitbucketSensor.probe(ctx, deps());
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /credentials/);
  });

  it("is unknown on a non-OK API response", async () => {
    process.env.BITBUCKET_TOKEN = "bbt";
    const out = await bitbucketSensor.probe(ctx, deps({ http: { ok: false, status: 403, body: "" } }));
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /403/);
  });
});
