import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  activePostHogHealthIssues,
  parsePostHogHealthIssues,
  posthogApiBase,
  posthogSensor,
} from "./posthog.js";
import type { HealthCtx, HealthDeps, HttpResponse } from "../health.js";

const issues = JSON.stringify({
  results: [
    {
      id: "1",
      kind: "no_live_events",
      severity: "critical",
      status: "active",
      title: "No live events",
      dismissed: false,
      snoozed_until: null,
    },
  ],
});

function deps(over: { http?: HttpResponse; urls?: string[] } = {}): HealthDeps {
  return {
    runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }),
    httpGet: async (url) => {
      over.urls?.push(url);
      return over.http ?? { ok: true, status: 200, body: issues };
    },
  };
}

const ctx: HealthCtx = { cwd: "/tmp/repo", config: {}, services: ["posthog"] };

describe("parsePostHogHealthIssues / activePostHogHealthIssues", () => {
  it("parses paginated health issues and ignores resolved/dismissed/snoozed rows", () => {
    const parsed = parsePostHogHealthIssues(
      JSON.stringify({
        results: [
          { status: "active", dismissed: false, snoozed_until: null },
          { status: "resolved", dismissed: false, snoozed_until: null },
          { status: "active", dismissed: true, snoozed_until: null },
          { status: "active", dismissed: false, snoozed_until: "2026-08-29T00:00:00Z" },
        ],
      }),
    );
    assert.equal(activePostHogHealthIssues(parsed).length, 1);
    assert.deepEqual(parsePostHogHealthIssues("nope"), []);
  });
});

describe("posthogApiBase", () => {
  afterEach(() => {
    delete process.env.POSTHOG_API_HOST;
    delete process.env.POSTHOG_HOST;
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  });

  it("maps the public ingestion host to the REST API host", () => {
    process.env.NEXT_PUBLIC_POSTHOG_HOST = "https://eu.i.posthog.com";
    assert.equal(posthogApiBase(), "https://eu.posthog.com");
  });
});

describe("posthogSensor.probe", () => {
  afterEach(() => {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
    delete process.env.POSTHOG_API_HOST;
    delete process.env.POSTHOG_HOST;
    delete process.env.NEXT_PUBLIC_POSTHOG_HOST;
  });

  function setEnv() {
    process.env.POSTHOG_PERSONAL_API_KEY = "phx_personal";
    process.env.POSTHOG_PROJECT_ID = "123";
  }

  it("emits red when active unsnoozed PostHog health issues exist", async () => {
    setEnv();
    const out = await posthogSensor.probe(ctx, deps());
    assert.equal(out[0].status, "red");
    assert.equal(out[0].severity, "critical");
    assert.match(out[0].title, /active health issue/);
  });

  it("emits green when no active unsnoozed health issues exist", async () => {
    setEnv();
    const out = await posthogSensor.probe(
      ctx,
      deps({ http: { ok: true, status: 200, body: JSON.stringify({ results: [] }) } }),
    );
    assert.equal(out[0].status, "green");
  });

  it("is unknown when PostHog API credentials are missing", async () => {
    const out = await posthogSensor.probe(ctx, deps());
    assert.equal(out[0].status, "unknown");
  });

  it("is unknown on a non-OK API response", async () => {
    setEnv();
    const out = await posthogSensor.probe(
      ctx,
      deps({ http: { ok: false, status: 401, body: "" } }),
    );
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /401/);
  });

  it("queries the active non-dismissed health-issues endpoint", async () => {
    setEnv();
    const urls: string[] = [];
    await posthogSensor.probe(ctx, deps({ urls }));
    assert.match(urls[0], /\/api\/projects\/123\/health_issues\/\?status=active&dismissed=false$/);
  });
});
