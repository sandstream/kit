import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { daysUntilExpiry, evaluateCert, tlsCertSensor } from "./tls-cert.js";
import type { HealthCtx, HealthDeps } from "../health.js";

const NOW = Date.parse("2026-06-01T00:00:00Z");

describe("daysUntilExpiry", () => {
  it("computes whole days; negative when past; null on garbage", () => {
    assert.equal(daysUntilExpiry("2026-06-11T00:00:00Z", NOW), 10);
    assert.equal(daysUntilExpiry("2026-05-22T00:00:00Z", NOW), -10);
    assert.equal(daysUntilExpiry("not-a-date", NOW), null);
  });
});

describe("evaluateCert", () => {
  it("green when comfortably ahead", () => {
    assert.equal(evaluateCert("a.com", 90, 21).status, "green");
  });
  it("red (high) when within the warn window", () => {
    const f = evaluateCert("a.com", 10, 21);
    assert.equal(f.status, "red");
    assert.equal(f.severity, "high");
    assert.equal(f.suggestedClass, "human");
  });
  it("red (critical) when already expired", () => {
    const f = evaluateCert("a.com", -3, 21);
    assert.equal(f.status, "red");
    assert.equal(f.severity, "critical");
    assert.match(f.title, /EXPIRED 3 day/);
  });
  it("unknown when expiry unreadable", () => {
    assert.equal(evaluateCert("a.com", null, 21).status, "unknown");
  });
});

describe("tlsCertSensor.probe", () => {
  const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };
  const deps: HealthDeps = {
    runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }),
    httpGet: async () => ({ ok: true, status: 200, body: "" }),
  };
  it("is unknown (not green) when KIT_TLS_HOST is unset", async () => {
    delete process.env.KIT_TLS_HOST;
    const out = await tlsCertSensor.probe(ctx, deps);
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /KIT_TLS_HOST not set/);
  });
});
