import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RunOutcome } from "./adjudicate.js";
import { parseManifest } from "./manifest.js";
import { aggregate, compare, LIMITS, spread, splitWarnings } from "./report.js";

const MANIFEST = parseManifest(`
[input]
repo = "acme/webapp"
commit = "${"c".repeat(40)}"
prompt = "p.md"

[[defect]]
id = "d1"
file = "a.ts"
line_start = 1
line_end = 1
kind = "k"
split = "tune"
patch = "d1.diff"

[[defect]]
id = "d2"
file = "a.ts"
line_start = 5
line_end = 5
kind = "k"
split = "tune"
patch = "d2.diff"

[[defect]]
id = "h1"
file = "b.ts"
line_start = 1
line_end = 1
kind = "k"
split = "holdout"
patch = "h1.diff"

[[control]]
id = "c1"
patch = "c1.diff"
`);

function defect(config: string, run: string, target: string, hit: boolean): RunOutcome {
  return {
    config,
    run,
    target,
    targetKind: "defect",
    caught: hit ? [target] : [],
    missed: hit ? [] : [target],
    duplicates: 0,
    falsePositives: 0,
    unmatched: 0,
  };
}

function control(config: string, run: string, fps: number): RunOutcome {
  return {
    config,
    run,
    target: "c1",
    targetKind: "control",
    caught: [],
    missed: [],
    duplicates: 0,
    falsePositives: fps,
    unmatched: 0,
  };
}

/** Three runs of a config: per-run tune recall from `hits` (d1, d2), holdout h1, control fps. */
function runs(config: string, hits: [boolean, boolean][], holdout = true): RunOutcome[] {
  return hits.flatMap(([a, b], i) => {
    const run = `r${i + 1}`;
    const out = [
      defect(config, run, "d1", a),
      defect(config, run, "d2", b),
      control(config, run, i % 2),
    ];
    if (holdout) out.push(defect(config, run, "h1", a));
    return out;
  });
}

describe("spread", () => {
  it("gives mean, min and max, and null for no values", () => {
    assert.deepEqual(spread([0.5, 1, 0]), { mean: 0.5, min: 0, max: 1 });
    assert.equal(spread([]), null);
  });
});

describe("aggregate", () => {
  it("reports tune and holdout separately, per-defect frequency and the control false-positive rate", () => {
    const [a] = aggregate(
      MANIFEST,
      runs("A", [
        [true, true],
        [true, false],
        [false, false],
      ]),
    );
    assert.equal(a.config, "A");
    assert.equal(a.tune.runs, 3);
    assert.deepEqual(a.tune.recall, { mean: 0.5, min: 0, max: 1 });
    assert.deepEqual(a.tune.perDefect, {
      d1: { caught: 2, reviewed: 3 },
      d2: { caught: 1, reviewed: 3 },
    });
    assert.deepEqual(a.holdout.perDefect, { h1: { caught: 2, reviewed: 3 } });
    assert.equal(a.controls.runs, 3);
    assert.deepEqual(a.controls.falsePositiveRate, { mean: 1 / 3, min: 0, max: 1 });
  });

  it("sorts configs, whatever order the runs arrive in", () => {
    const stats = aggregate(MANIFEST, [...runs("B", [[true, true]]), ...runs("A", [[true, true]])]);
    assert.deepEqual(
      stats.map((s) => s.config),
      ["A", "B"],
    );
  });
});

describe("compare", () => {
  it("refuses below three runs per config", () => {
    const [a, b] = aggregate(MANIFEST, [
      ...runs("A", [[true, true]]),
      ...runs("B", [
        [true, true],
        [true, true],
        [true, true],
      ]),
    ]);
    const c = compare(a.tune, b.tune);
    assert.equal(c.verdict, "refused");
  });

  it("calls a difference outside spread only when the recall ranges do not overlap", () => {
    const stats = aggregate(MANIFEST, [
      ...runs("A", [
        [true, true],
        [true, true],
        [true, false],
      ]),
      ...runs("B", [
        [false, false],
        [false, false],
        [false, false],
      ]),
      ...runs("C", [
        [true, false],
        [false, false],
        [true, true],
      ]),
    ]);
    const [a, b, c] = stats;
    assert.equal(compare(a.tune, b.tune).verdict, "outside spread");
    assert.equal(compare(a.tune, c.tune).verdict, "within spread");
  });
});

describe("splitWarnings", () => {
  it("warns when only tune defects were run, or no control was", () => {
    const tuneOnly = aggregate(MANIFEST, runs("A", [[true, true]], false));
    assert.deepEqual(splitWarnings(tuneOnly), [
      "config A: only tune defects were run; its numbers are fitted to the tuning set",
    ]);
    const noControl = aggregate(MANIFEST, [defect("B", "r1", "h1", true)]);
    assert.deepEqual(splitWarnings(noControl), [
      "config B: no control runs, so false positives are unmeasured",
    ]);
  });
});

describe("LIMITS", () => {
  it("states ADR-0007's three limits", () => {
    assert.equal(LIMITS.length, 3);
    assert.match(LIMITS[0], /^Lower bound only/);
    assert.match(LIMITS[1], /^Goodhart/);
    assert.match(LIMITS[2], /^Transfer is unproven/);
  });
});
