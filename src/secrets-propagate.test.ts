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
