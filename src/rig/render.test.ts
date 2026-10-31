import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseManifest } from "./manifest.js";
import { renderPlan, renderReport } from "./render.js";
import type { RigResult } from "./store.js";

const MANIFEST = parseManifest(`
[input]
repo = "acme/webapp"
commit = "${"a".repeat(40)}"
prompt = "p.md"
tolerance = 2

[[defect]]
id = "d1"
file = "a.ts"
line_start = 1
line_end = 1
kind = "k"
split = "holdout"
patch = "d1.diff"

[[control]]
id = "c1"
patch = "c1.diff"
`);

const RESULT: RigResult = {
  inputId: "9".repeat(64),
  adjudicatedAt: "2026-10-31T00:00:00.000Z",
  outcomes: [],
  unknownTargets: [
    { run: "r9", config: "A", target: "zz", model: "m", model_version: "1", date: "2026-10-31" },
  ],
  stats: [
    {
      config: "A",
      tune: { runs: 0, recall: null, falsePositiveRate: null, perDefect: {} },
      holdout: {
        runs: 1,
        recall: { mean: 1, min: 1, max: 1 },
        falsePositiveRate: null,
        perDefect: { d1: { caught: 1, reviewed: 1 } },
      },
      controls: { runs: 1, falsePositiveRate: { mean: 0, min: 0, max: 0 } },
    },
    {
      config: "B",
      tune: { runs: 0, recall: null, falsePositiveRate: null, perDefect: {} },
      holdout: {
        runs: 1,
        recall: { mean: 0, min: 0, max: 0 },
        falsePositiveRate: null,
        perDefect: {},
      },
      controls: { runs: 0, falsePositiveRate: null },
    },
  ],
  warnings: ["config B: no control runs, so false positives are unmeasured"],
  receipt: {
    inputId: "9".repeat(64),
    findings: ["x"],
    summary: {},
    signature: null,
    unsignedReason: "no identity",
  },
};

describe("renderPlan", () => {
  it("names the input, every target with its split and patch, and the next commands", () => {
    const text = renderPlan(MANIFEST, "1".repeat(64), "out.jsonl").join("\n");
    assert.match(text, /input id {2}1{64}/);
    assert.match(text, /tolerance 2 line\(s\)/);
    assert.match(text, /defect {2}d1 +holdout +d1\.diff/);
    assert.match(text, /control c1 +c1\.diff/);
    assert.match(text, /kit rig ingest out\.jsonl/);
  });
});

describe("renderReport", () => {
  it("shows per-config recall, refused comparisons, warnings, the receipt and the three limits", () => {
    const text = renderReport(RESULT, ["0".repeat(64)]).join("\n");
    assert.match(text, /holdout {2}1 run\(s\) {2}recall 100\.0% \(min 100\.0%, max 100\.0%\)/);
    assert.match(text, /tune {5}0 run\(s\) {2}recall not measured/);
    assert.match(text, /d1 +caught 1\/1/);
    assert.match(text, /A vs B \(holdout\): refused: each config needs at least 3 runs/);
    assert.match(text, /warning: config B: no control runs/);
    assert.match(text, /reviewed unknown target "zz"; not counted/);
    assert.match(text, /1 other input id\(s\) on record were not mixed in/);
    assert.match(text, /receipt: unsigned \(no identity\)/);
    assert.match(
      text,
      /Limits \(ADR-0007\):\n {2}1\. Lower bound only.*\n {2}2\. Goodhart.*\n {2}3\. Transfer is unproven/,
    );
  });
});
