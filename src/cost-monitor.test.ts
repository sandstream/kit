import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleCosts, detectCostAnomalies, type CostSample } from "./cost-monitor.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "kit-cost-"));
}

function sample(opts: Partial<CostSample> = {}): CostSample {
  return {
    provider: "stripe",
    policyKey: "STRIPE_SECRET_KEY",
    current: 100,
    unit: "usd",
    status: "ok",
    detail: "",
    ...opts,
  };
}

describe("sampleCosts", () => {
  it("returns no samples when no provider env vars are set", async () => {
    const samples = await sampleCosts({ caps: {}, env: {} });
    assert.equal(samples.length, 0);
  });

  it("returns stub entries for known-but-unimplemented providers", async () => {
    const samples = await sampleCosts({
      caps: {},
      env: { OPENAI_API_KEY: "sk-test-anything" },
    });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].provider, "openai");
    assert.equal(samples[0].status, "no-api");
  });

  it("emits a stripe sample (status varies on network) when STRIPE_SECRET_KEY is present", async () => {
    const samples = await sampleCosts({
      caps: { STRIPE_SECRET_KEY: 100 },
      env: {
        // Invalid key — Stripe will 401 (or the connection fails). Either
        // outcome maps to a non-fatal status code, not a crash.
        STRIPE_SECRET_KEY: "sk_test_invalid_for_test_purposes_only",
      },
    });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].provider, "stripe");
    assert.equal(samples[0].policyKey, "STRIPE_SECRET_KEY");
    // capUsd should be preserved
    assert.equal(samples[0].capUsd, 100);
    // status is one of the documented non-ok terminal states
    assert.ok(
      ["auth-failed", "no-api", "ok", "warn", "over-cap"].includes(samples[0].status),
      `unexpected status: ${samples[0].status}`,
    );
  });

  it("multiple providers in the same call", async () => {
    const samples = await sampleCosts({
      caps: {},
      env: {
        OPENAI_API_KEY: "sk-test",
        ANTHROPIC_API_KEY: "sk-ant-test",
        RESEND_API_KEY: "re_test",
      },
    });
    assert.equal(samples.length, 3);
    const providers = samples.map((s) => s.provider).sort();
    assert.deepEqual(providers, ["anthropic", "openai", "resend"]);
  });
});

describe("detectCostAnomalies", () => {
  it("no alerts on first sample (baseline equals current)", async () => {
    const dir = tmpDir();
    try {
      const alerts = await detectCostAnomalies([sample({ current: 100 })], { cwd: dir });
      assert.equal(alerts.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns at 2× baseline", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, ".kit-cost-baseline.json"),
        JSON.stringify({
          STRIPE_SECRET_KEY: {
            policyKey: "STRIPE_SECRET_KEY",
            avgDailyUsd: 50,
            lastSampleUsd: 50,
            updatedAt: "2026-01-01T00:00:00Z",
            sampleCount: 5,
          },
        }),
      );
      const alerts = await detectCostAnomalies([sample({ current: 100 })], { cwd: dir });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]!.severity, "warn");
      assert.equal(alerts[0]!.multiplier, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escalates to critical at 4× baseline", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, ".kit-cost-baseline.json"),
        JSON.stringify({
          STRIPE_SECRET_KEY: {
            policyKey: "STRIPE_SECRET_KEY",
            avgDailyUsd: 25,
            lastSampleUsd: 25,
            updatedAt: "2026-01-01T00:00:00Z",
            sampleCount: 5,
          },
        }),
      );
      const alerts = await detectCostAnomalies([sample({ current: 100 })], { cwd: dir });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]!.severity, "critical");
      assert.equal(alerts[0]!.multiplier, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("critical when current > capUsd * 1.5", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, ".kit-cost-baseline.json"),
        JSON.stringify({
          STRIPE_SECRET_KEY: {
            policyKey: "STRIPE_SECRET_KEY",
            avgDailyUsd: 90,
            lastSampleUsd: 90,
            updatedAt: "2026-01-01T00:00:00Z",
            sampleCount: 5,
          },
        }),
      );
      const alerts = await detectCostAnomalies([sample({ current: 100, capUsd: 50 })], {
        cwd: dir,
      });
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]!.severity, "critical");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips auth-failed + no-api samples", async () => {
    const dir = tmpDir();
    try {
      const alerts = await detectCostAnomalies(
        [
          sample({ status: "auth-failed", current: 9999 }),
          sample({ status: "no-api", current: 9999, policyKey: "OPENAI" }),
        ],
        { cwd: dir },
      );
      assert.equal(alerts.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists EMA baseline (weight 0.2)", async () => {
    const dir = tmpDir();
    try {
      writeFileSync(
        join(dir, ".kit-cost-baseline.json"),
        JSON.stringify({
          STRIPE_SECRET_KEY: {
            policyKey: "STRIPE_SECRET_KEY",
            avgDailyUsd: 50,
            lastSampleUsd: 50,
            updatedAt: "2026-01-01T00:00:00Z",
            sampleCount: 5,
          },
        }),
      );
      await detectCostAnomalies([sample({ current: 100 })], { cwd: dir });
      const file = readFileSync(join(dir, ".kit-cost-baseline.json"), "utf-8");
      const parsed = JSON.parse(file);
      assert.equal(parsed.STRIPE_SECRET_KEY.avgDailyUsd, 60);
      assert.equal(parsed.STRIPE_SECRET_KEY.sampleCount, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persist=false leaves no baseline file", async () => {
    const dir = tmpDir();
    try {
      await detectCostAnomalies([sample({ current: 100 })], {
        cwd: dir,
        persist: false,
      });
      let exists = true;
      try {
        readFileSync(join(dir, ".kit-cost-baseline.json"));
      } catch {
        exists = false;
      }
      assert.equal(exists, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
