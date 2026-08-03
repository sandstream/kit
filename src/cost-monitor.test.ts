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

describe("detectCostAnomalies — boundaries, malformed baselines and fail-open paths", () => {
  const BASELINE = ".kit-cost-baseline.json";

  function writeBaseline(dir: string, raw: string): void {
    writeFileSync(join(dir, BASELINE), raw);
  }

  function baselineFixture(avgDailyUsd: number, sampleCount = 5): string {
    return JSON.stringify({
      STRIPE_SECRET_KEY: {
        policyKey: "STRIPE_SECRET_KEY",
        avgDailyUsd,
        lastSampleUsd: avgDailyUsd,
        updatedAt: "2026-01-01T00:00:00Z",
        sampleCount,
      },
    });
  }

  it("writes an empty baseline map when given no samples at all", async () => {
    const dir = tmpDir();
    try {
      const alerts = await detectCostAnomalies([], { cwd: dir });
      assert.equal(alerts.length, 0);
      // Persist runs unconditionally, so an empty run still rewrites the file.
      // The exact bytes matter: the file is human-readable state other tooling
      // (and the next run's JSON.parse) depends on, newline included.
      assert.equal(readFileSync(join(dir, BASELINE), "utf-8"), "{}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("raises no alert when the stored baseline is zero, however large the reading", async () => {
    const dir = tmpDir();
    try {
      writeBaseline(dir, baselineFixture(0));
      const alerts = await detectCostAnomalies([sample({ current: 5000 })], { cwd: dir });
      // A zero baseline short-circuits the multiplier to 1, so a 5000 USD
      // reading against a 0 baseline is silently normal. This is the blind
      // spot a leak detector most needs to be honest about.
      assert.equal(alerts.length, 0);
      const parsed = JSON.parse(readFileSync(join(dir, BASELINE), "utf-8"));
      // The spike still moves the EMA: 0 * 0.8 + 5000 * 0.2
      assert.equal(parsed.STRIPE_SECRET_KEY.avgDailyUsd, 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a declared cap of zero because the guard tests truthiness", async () => {
    const dir = tmpDir();
    try {
      const alerts = await detectCostAnomalies([sample({ current: 100, capUsd: 0 })], { cwd: dir });
      // capUsd 0 ("spend nothing") is falsy, so the cap branch never runs and
      // 100 USD against a zero cap produces no alert.
      assert.equal(alerts.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags a cap breach as critical on the very first sample, before any baseline exists", async () => {
    const dir = tmpDir();
    try {
      const alerts = await detectCostAnomalies([sample({ current: 100, capUsd: 10 })], {
        cwd: dir,
      });
      assert.equal(alerts.length, 1);
      // The cap branch is checked before the multiplier branch, so it fires
      // even though baseline === current makes the multiplier exactly 1.
      assert.equal(alerts[0]!.severity, "critical");
      assert.equal(alerts[0]!.multiplier, 1);
      assert.equal(alerts[0]!.baselineUsd, 100);
      assert.equal(alerts[0]!.detail, "current 100.00 USD vs baseline 100.00 (1.0×); cap 10");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays silent just below the warn multiplier", async () => {
    const dir = tmpDir();
    try {
      writeBaseline(dir, baselineFixture(50));
      // 99/50 = 1.98 — under the inclusive >= 2 warn threshold.
      const alerts = await detectCostAnomalies([sample({ current: 99 })], { cwd: dir });
      assert.equal(alerts.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honours caller-supplied warn and critical multipliers", async () => {
    const dir = tmpDir();
    try {
      writeBaseline(dir, baselineFixture(10));
      // 50/10 = 5×, which is critical under the defaults (>= 4).
      const downgraded = await detectCostAnomalies([sample({ current: 50 })], {
        cwd: dir,
        criticalMultiplier: 10,
        persist: false,
      });
      assert.equal(downgraded.length, 1);
      assert.equal(downgraded[0]!.severity, "warn");
      assert.equal(downgraded[0]!.multiplier, 5);

      // Raising the warn floor above the observed multiplier suppresses it
      // entirely — the thresholds are the only gate, there is no floor alert.
      const silenced = await detectCostAnomalies([sample({ current: 50 })], {
        cwd: dir,
        warnMultiplier: 6,
        criticalMultiplier: 10,
        persist: false,
      });
      assert.equal(silenced.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compares a repeated policyKey within one call against the baseline the earlier sample just set", async () => {
    const dir = tmpDir();
    try {
      const alerts = await detectCostAnomalies(
        [sample({ current: 100 }), sample({ current: 400 })],
        { cwd: dir },
      );
      // The in-memory map is mutated as the loop goes, so the second reading
      // is measured against 100 (from the first) rather than against itself.
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0]!.currentUsd, 400);
      assert.equal(alerts[0]!.baselineUsd, 100);
      assert.equal(alerts[0]!.severity, "critical");
      const parsed = JSON.parse(readFileSync(join(dir, BASELINE), "utf-8"));
      // Both samples counted, EMA applied once on top of the first: 100*0.8 + 400*0.2
      assert.equal(parsed.STRIPE_SECRET_KEY.avgDailyUsd, 160);
      assert.equal(parsed.STRIPE_SECRET_KEY.sampleCount, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an unparseable baseline file as absent and overwrites it with valid JSON", async () => {
    const dir = tmpDir();
    try {
      writeBaseline(dir, "{ this is not json");
      const alerts = await detectCostAnomalies([sample({ current: 9999 })], { cwd: dir });
      // Fail-open: corruption loses the history, so the first run after it
      // cannot detect a spike. Worth knowing before trusting a quiet report.
      assert.equal(alerts.length, 0);
      const parsed = JSON.parse(readFileSync(join(dir, BASELINE), "utf-8"));
      assert.equal(parsed.STRIPE_SECRET_KEY.avgDailyUsd, 9999);
      assert.equal(parsed.STRIPE_SECRET_KEY.sampleCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("silently fails to persist when the baseline file holds a JSON array", async () => {
    const dir = tmpDir();
    try {
      writeBaseline(dir, "[]");
      const alerts = await detectCostAnomalies([sample({ current: 100 })], { cwd: dir });
      assert.equal(alerts.length, 0);
      const raw = readFileSync(join(dir, BASELINE), "utf-8");
      // The parsed array is used as the map, so the named key is set as an
      // array property and dropped by JSON.stringify. The file never grows a
      // baseline and every future run restarts from scratch.
      assert.equal(raw.trim(), "[]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects with a TypeError when the baseline file holds JSON null", async () => {
    const dir = tmpDir();
    try {
      writeBaseline(dir, "null");
      // JSON.parse succeeds, so the try/catch in the loader does not fire and
      // the null propagates to a property read on the very next line.
      await assert.rejects(
        () => detectCostAnomalies([sample({ current: 100 })], { cwd: dir }),
        TypeError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
