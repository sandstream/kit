import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreSlopsquatRisk,
  parseNpmRegistry,
  parsePypiRegistry,
  assessPackage,
  type PackageMeta,
} from "./slopsquat.js";

const NOW = Date.parse("2026-07-08T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const meta = (over: Partial<PackageMeta> = {}): PackageMeta => ({
  ecosystem: "npm",
  name: "pkg",
  exists: true,
  ageDays: 1000,
  releaseCount: 40,
  lastPublishDays: 10,
  ...over,
});

describe("scoreSlopsquatRisk (pure)", () => {
  it("rates an established package low", () => {
    const r = scoreSlopsquatRisk(meta());
    assert.equal(r.level, "low");
    assert.equal(r.score, 0);
    assert.deepEqual(r.signals, []);
  });

  it("rates a nonexistent name critical (the hallucination signal)", () => {
    const r = scoreSlopsquatRisk(meta({ exists: false, ageDays: null, releaseCount: null }));
    assert.equal(r.level, "critical");
    assert.ok(r.score >= 80);
    assert.ok(r.signals[0].includes("nonexistent"));
  });

  it("stacks youth + single release into high/critical", () => {
    const r = scoreSlopsquatRisk(meta({ ageDays: 3, releaseCount: 1 }));
    // <7d (50) + single release (25) = 75 → high
    assert.equal(r.score, 75);
    assert.equal(r.level, "high");
    assert.ok(r.signals.some((s) => s.includes("<7 days")));
    assert.ok(r.signals.some((s) => s.includes("one published release")));
  });

  it("treats a lookup failure as caution, not green", () => {
    const r = scoreSlopsquatRisk(meta({ lookupFailed: true, ageDays: null, releaseCount: null }));
    assert.equal(r.level, "medium");
    assert.ok(r.signals.some((s) => s.includes("unavailable")));
  });

  it("scales youth bands (7-30d medium, 30-90d lower)", () => {
    assert.equal(scoreSlopsquatRisk(meta({ ageDays: 20, releaseCount: 40 })).level, "medium"); // 35
    assert.equal(scoreSlopsquatRisk(meta({ ageDays: 60, releaseCount: 40 })).level, "low"); // 15
  });

  it("caps the score at 100 and is deterministic", () => {
    const bad = meta({ exists: false, ageDays: null, releaseCount: null });
    const a = scoreSlopsquatRisk(bad);
    const b = scoreSlopsquatRisk(bad);
    assert.ok(a.score <= 100);
    assert.deepEqual(a, b);
  });
});

describe("registry parsers (pure)", () => {
  it("parses an npm document (age from time.created, count from versions)", () => {
    const m = parseNpmRegistry(
      "lodash",
      {
        time: { created: daysAgo(4000), modified: daysAgo(30) },
        versions: { "1.0.0": {}, "1.0.1": {}, "2.0.0": {} },
      },
      NOW,
    );
    assert.equal(m.exists, true);
    assert.equal(m.ageDays, 4000);
    assert.equal(m.lastPublishDays, 30);
    assert.equal(m.releaseCount, 3);
  });

  it("parses a PyPI document (earliest/latest upload across releases)", () => {
    const m = parsePypiRegistry(
      "requests",
      {
        releases: {
          "0.1.0": [{ upload_time_iso_8601: daysAgo(3000) }],
          "2.0.0": [{ upload_time_iso_8601: daysAgo(10) }],
        },
      },
      NOW,
    );
    assert.equal(m.ageDays, 3000);
    assert.equal(m.lastPublishDays, 10);
    assert.equal(m.releaseCount, 2);
  });

  it("tolerates missing/garbage fields without throwing", () => {
    const m = parseNpmRegistry("x", {}, NOW);
    assert.equal(m.ageDays, null);
    assert.equal(m.releaseCount, null);
    assert.equal(parsePypiRegistry("y", {}, NOW).releaseCount, null);
  });
});

describe("assessPackage (injected fetcher — no network)", () => {
  it("scores a hallucinated npm name as critical", async () => {
    const r = await assessPackage("npm", "reqeusts-helper", {
      fetchMeta: async (ecosystem, name) => ({
        ecosystem,
        name,
        exists: false,
        ageDays: null,
        releaseCount: null,
        lastPublishDays: null,
      }),
    });
    assert.equal(r.level, "critical");
    assert.equal(r.name, "reqeusts-helper");
  });

  it("scores an established package low", async () => {
    const r = await assessPackage("pypi", "requests", {
      fetchMeta: async (ecosystem, name) => ({
        ecosystem,
        name,
        exists: true,
        ageDays: 3000,
        releaseCount: 150,
        lastPublishDays: 20,
      }),
    });
    assert.equal(r.level, "low");
  });
});
