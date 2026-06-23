import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatHealth, type HealthFinding } from "./health.js";

const findings: HealthFinding[] = [
  {
    sensor: "github-actions",
    source: "acme/webapp",
    status: "red",
    severity: "high",
    title: "workflow failing: CI",
  },
  { sensor: "github-actions", source: "acme/webapp", status: "green", title: "all green" },
  { sensor: "x", source: "y", status: "unknown", title: "probe errored" },
];

describe("formatHealth", () => {
  it("counts red findings and renders a line per finding", () => {
    const out = formatHealth(findings);
    assert.equal(out.redCount, 1);
    assert.equal(out.lines.length, 3);
    assert.ok(out.lines.some((l) => l.includes("workflow failing: CI")));
    assert.ok(out.lines.some((l) => l.includes("acme/webapp")));
  });

  it("redCount is 0 when nothing is red", () => {
    const out = formatHealth([{ sensor: "a", source: "s", status: "green", title: "ok" }]);
    assert.equal(out.redCount, 0);
  });
});
