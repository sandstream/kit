import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { actionableHealth, healthFindingToSync } from "./health-track.js";
import type { HealthFinding } from "./health.js";

const findings: HealthFinding[] = [
  {
    sensor: "github-actions",
    source: "acme/webapp",
    status: "red",
    severity: "high",
    title: "workflow failing: CI",
    detail: "latest CI failed",
  },
  { sensor: "github-actions", source: "acme/webapp", status: "green", title: "all green" },
  { sensor: "github-actions", source: "acme/webapp", status: "unknown", title: "probe errored" },
];

describe("actionableHealth", () => {
  it("keeps only red findings (green + unknown are not action items)", () => {
    const out = actionableHealth(findings);
    assert.equal(out.length, 1);
    assert.equal(out[0].title, "workflow failing: CI");
  });
});

describe("healthFindingToSync", () => {
  it("produces a stable dedup key of sensor:title", () => {
    const s = healthFindingToSync(findings[0]);
    assert.equal(s.dedupKey, "github-actions:workflow failing: CI");
    assert.equal(s.title, "workflow failing: CI");
    assert.equal(s.detail, "latest CI failed");
  });
});
