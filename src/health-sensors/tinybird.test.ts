import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseTinybirdJobs, tinybirdJobsByStatus, tinybirdSensor } from "./tinybird.js";
import type { HealthCtx, HealthDeps, HttpResponse } from "../health.js";

const failedJobs = JSON.stringify({
  jobs: [
    {
      id: "j1",
      kind: "import",
      status: "error",
      datasource: { name: "events" },
    },
  ],
});

function deps(over: { http?: HttpResponse; urls?: string[] } = {}): HealthDeps {
  return {
    runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }),
    httpGet: async (url) => {
      over.urls?.push(url);
      return over.http ?? { ok: true, status: 200, body: failedJobs };
    },
  };
}

const ctx: HealthCtx = { cwd: "/tmp/repo", config: {}, services: ["tinybird"] };

describe("parseTinybirdJobs / tinybirdJobsByStatus", () => {
  it("separates failed and pending Tinybird jobs", () => {
    const parsed = parseTinybirdJobs(
      JSON.stringify({
        jobs: [
          { id: "j1", status: "error" },
          { id: "j2", status: "working" },
          { id: "j3", status: "waiting" },
          { id: "j4", status: "done" },
        ],
      }),
    );
    const grouped = tinybirdJobsByStatus(parsed);
    assert.equal(grouped.failed.length, 1);
    assert.equal(grouped.pending.length, 2);
    assert.deepEqual(parseTinybirdJobs("nope"), []);
  });
});

describe("tinybirdSensor.probe", () => {
  afterEach(() => {
    delete process.env.TINYBIRD_TOKEN;
    delete process.env.TINYBIRD_API_URL;
  });

  it("emits red when recent Tinybird jobs failed", async () => {
    process.env.TINYBIRD_TOKEN = "p.token";
    const out = await tinybirdSensor.probe(ctx, deps());
    assert.equal(out[0].status, "red");
    assert.match(out[0].title, /failed job/);
    assert.match(out[0].detail ?? "", /events/);
  });

  it("emits unknown while Tinybird jobs are still running", async () => {
    process.env.TINYBIRD_TOKEN = "p.token";
    const body = JSON.stringify({ jobs: [{ id: "j2", kind: "copy", status: "working" }] });
    const out = await tinybirdSensor.probe(ctx, deps({ http: { ok: true, status: 200, body } }));
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /still running/);
  });

  it("emits green when recent Tinybird jobs are done", async () => {
    process.env.TINYBIRD_TOKEN = "p.token";
    const body = JSON.stringify({ jobs: [{ id: "j3", kind: "import", status: "done" }] });
    const out = await tinybirdSensor.probe(ctx, deps({ http: { ok: true, status: 200, body } }));
    assert.equal(out[0].status, "green");
  });

  it("is unknown when TINYBIRD_TOKEN is missing", async () => {
    const out = await tinybirdSensor.probe(ctx, deps());
    assert.equal(out[0].status, "unknown");
  });

  it("is unknown on a non-OK API response", async () => {
    process.env.TINYBIRD_TOKEN = "p.token";
    const out = await tinybirdSensor.probe(
      ctx,
      deps({ http: { ok: false, status: 401, body: "" } }),
    );
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /401/);
  });

  it("uses the configured Tinybird API host", async () => {
    process.env.TINYBIRD_TOKEN = "p.token";
    process.env.TINYBIRD_API_URL = "https://api.eu-central-1.aws.tinybird.co/";
    const urls: string[] = [];
    await tinybirdSensor.probe(ctx, deps({ urls }));
    assert.equal(urls[0], "https://api.eu-central-1.aws.tinybird.co/v0/jobs");
  });
});
