import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTargets, ALL_TARGETS, propagate } from "./secrets-propagate.js";

describe("parseTargets", () => {
  it("parses a comma-separated list of known targets", () => {
    const ts = parseTargets("vercel,github,fly");
    assert.deepEqual(ts.sort(), ["fly", "github", "vercel"]);
  });

  it("drops unknown tokens silently", () => {
    const ts = parseTargets("vercel,unknown,railway");
    assert.deepEqual(ts.sort(), ["railway", "vercel"]);
  });

  it("returns empty on empty input", () => {
    assert.deepEqual(parseTargets(""), []);
  });

  it("trims whitespace", () => {
    const ts = parseTargets(" vercel , github ");
    assert.deepEqual(ts.sort(), ["github", "vercel"]);
  });
});

describe("ALL_TARGETS", () => {
  it("includes every supported platform", () => {
    assert.ok(ALL_TARGETS.includes("vercel"));
    assert.ok(ALL_TARGETS.includes("github"));
    assert.ok(ALL_TARGETS.includes("fly"));
    assert.ok(ALL_TARGETS.includes("cloudflare"));
    assert.ok(ALL_TARGETS.includes("railway"));
    assert.ok(ALL_TARGETS.includes("aws-ssm"));
  });
});

describe("propagate", () => {
  it("returns one result per requested target", async () => {
    // The underlying CLIs (vercel/gh/fly/wrangler/railway/aws) won't be in
    // PATH in this test runner, so each adapter exits non-zero with code 127
    // (command not found). What we care about here is the SHAPE: one result
    // per target, no exceptions thrown out.
    const results = await propagate("TEST_KEY", "test-value", ["vercel", "github"]);
    assert.equal(results.length, 2);
    assert.equal(results[0].target, "vercel");
    assert.equal(results[1].target, "github");
  });

  it("flags fly + railway as 'value in argv' for documentation", async () => {
    const results = await propagate("X", "y", ["fly", "railway"], {
      flyApp: "test-app",
    });
    // fly has flyApp; railway has no required option, just runs
    const fly = results.find((r) => r.target === "fly");
    const rail = results.find((r) => r.target === "railway");
    assert.equal(fly?.valueInArgv, true);
    assert.equal(rail?.valueInArgv, true);
  });

  it("aws-ssm uses stdin so the value never enters argv", async () => {
    const results = await propagate("X", "y", ["aws-ssm"], { awsRegion: "eu-north-1" });
    assert.equal(results[0].valueInArgv, false);
  });

  it("uses Vercel API project writes without leaking the value in result text or URLs", async () => {
    const priorToken = process.env.VERCEL_TOKEN;
    const priorFetch = globalThis.fetch;
    const calls: { url: string; method: string; body?: string }[] = [];
    process.env.VERCEL_TOKEN = "test-token";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ envs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ id: "env_1", key: "API_KEY", target: ["preview"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const results = await propagate("API_KEY", "super-secret-value", ["vercel"], {
        env: "preview",
        vercelProject: "app-stg",
        vercelTeamId: "team_123",
      });
      assert.equal(results[0].ok, true);
      assert.equal(results[0].valueInArgv, false);
      assert.equal(results[0].detail.includes("super-secret-value"), false);
      assert.ok(calls.every((call) => !call.url.includes("super-secret-value")));
      assert.match(
        calls[0]?.url ?? "",
        /\/v9\/projects\/app-stg\/env\?decrypt=false&teamId=team_123$/,
      );
      assert.match(calls[1]?.url ?? "", /\/v10\/projects\/app-stg\/env\?teamId=team_123$/);
    } finally {
      if (priorToken === undefined) delete process.env.VERCEL_TOKEN;
      else process.env.VERCEL_TOKEN = priorToken;
      globalThis.fetch = priorFetch;
    }
  });

  it("returns a non-ok result with a clear missing-opt message for fly without --fly-app", async () => {
    const results = await propagate("X", "y", ["fly"]);
    assert.equal(results[0].ok, false);
    assert.ok(results[0].detail.includes("fly-app"));
  });

  it("returns a non-ok result for cloudflare without --cf-worker", async () => {
    const results = await propagate("X", "y", ["cloudflare"]);
    assert.equal(results[0].ok, false);
    assert.ok(results[0].detail.includes("cf-worker"));
  });
});
