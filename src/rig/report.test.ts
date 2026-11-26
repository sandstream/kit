import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjudicate, type RunOutcome } from "./adjudicate.js";
import { parseFindings } from "./findings.js";
import { parseManifest } from "./manifest.js";
import {
  aggregate,
  compare,
  compareConfigs,
  LIMITS,
  spread,
  splitWarnings,
  VOLUME_RATIO_LIMIT,
} from "./report.js";

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

describe("volume", () => {
  it("counts findings per run and unmatched ones, so flooding is visible without controls", () => {
    const flood: RunOutcome = { ...defect("F", "r1", "d1", true), duplicates: 4, unmatched: 95 };
    const quiet = defect("Q", "r1", "d1", true);
    const [f, q] = aggregate(MANIFEST, [flood, quiet]);
    assert.deepEqual(f.tune.recall, q.tune.recall, "the same recall either way");
    assert.deepEqual(f.volume, {
      findingsPerRun: { mean: 100, min: 100, max: 100 },
      unmatched: 95,
      duplicatesPerRun: { mean: 4, min: 4, max: 4 },
      precision: { mean: 0.01, min: 0.01, max: 0.01 },
    });
    assert.deepEqual(q.volume, {
      findingsPerRun: { mean: 1, min: 1, max: 1 },
      unmatched: 0,
      duplicatesPerRun: { mean: 0, min: 0, max: 0 },
      precision: { mean: 1, min: 1, max: 1 },
    });
    const withControl = aggregate(MANIFEST, [quiet, control("Q", "r1", 2)]);
    assert.deepEqual(withControl[0].volume?.findingsPerRun, { mean: 3, min: 3, max: 3 });
  });
});

describe("a spent holdout", () => {
  it("warns once three or more configs were scored on the same holdout", () => {
    const two = aggregate(MANIFEST, [
      defect("A", "r1", "h1", true),
      defect("B", "r1", "h1", false),
    ]);
    assert.ok(!splitWarnings(two).some((w) => w.includes("same holdout")));
    const three = aggregate(MANIFEST, [
      defect("A", "r1", "h1", true),
      defect("B", "r1", "h1", false),
      defect("C", "r1", "h1", true),
    ]);
    assert.ok(
      splitWarnings(three).some((w) => w.startsWith("3 configs were scored on the same holdout")),
    );
  });
});

describe("a run that did not review every target", () => {
  const row = (o: Record<string, unknown>): string =>
    JSON.stringify({
      config: "A",
      run: "r1",
      model: "m",
      model_version: "1",
      date: "2026-11-25",
      ...o,
    });
  const hit = (target: string, file: string, line: number) =>
    row({ target, file, line, claim: "x", severity: "high" });
  const statsOf = (...rows: string[]) =>
    aggregate(MANIFEST, adjudicate(MANIFEST, parseFindings(rows.join("\n"))).outcomes)[0];

  it("counts a defect with no row in that run as not caught", () => {
    const a = statsOf(hit("d1", "a.ts", 1), hit("h1", "b.ts", 1));
    assert.deepEqual(a.tune.recall, { mean: 0.5, min: 0.5, max: 0.5 });
    assert.deepEqual(a.holdout.recall, { mean: 1, min: 1, max: 1 });
    assert.deepEqual(a.tune.shortfall, [
      { run: "r1", reviewed: 1, of: 2, failed: [], missing: ["d2"] },
    ]);
    assert.deepEqual(a.holdout.shortfall, []);
  });

  it("counts a failed or refused defect as not caught, and never as reviewed", () => {
    const a = statsOf(hit("d1", "a.ts", 1), row({ target: "d2", failed: "timeout" }));
    assert.deepEqual(a.tune.recall, { mean: 0.5, min: 0.5, max: 0.5 });
    assert.deepEqual(a.tune.perDefect, { d1: { caught: 1, reviewed: 1 } });
    assert.deepEqual(a.tune.shortfall, [
      { run: "r1", reviewed: 1, of: 2, failed: [{ target: "d2", reason: "timeout" }], missing: [] },
    ]);
    assert.equal(a.holdout.runs, 0);
  });

  it("counts a failed control as flagged, never as clean", () => {
    const a = statsOf(hit("d1", "a.ts", 1), row({ target: "c1", failed: "refused" }));
    assert.deepEqual(a.controls.falsePositiveRate, { mean: 1, min: 1, max: 1 });
    assert.equal(a.controls.shortfall?.[0].failed[0].reason, "refused");
  });
});

describe("a flooding reviewer against a precise one", () => {
  /** Three runs: each catches d1 once; `extra` more findings land on d1 and on the control. */
  const config = (name: string, duplicates: number, unmatched: number, fps: number) =>
    [1, 2, 3].flatMap((n) => [
      { ...defect(name, `r${n}`, "d1", true), duplicates, unmatched },
      control(name, `r${n}`, fps),
    ]);

  it("does not call recall-equal configs comparable when volume differs tenfold", () => {
    const [flood, precise] = aggregate(MANIFEST, [
      ...config("FLOOD", 9, 990, 1000),
      ...config("PRECISE", 0, 0, 0),
    ]);
    assert.equal(compare(flood.tune, precise.tune).verdict, "within spread");
    const c = compareConfigs(flood, precise, "tune");
    assert.equal(c.verdict, "within spread");
    assert.equal(c.verdict === "within spread" ? c.volumeRatio : undefined, 2000);
    assert.deepEqual(flood.volume?.duplicatesPerRun, { mean: 9, min: 9, max: 9 });
    assert.equal(flood.volume?.precision?.mean, 1 / 2000);
    assert.equal(precise.volume?.precision?.mean, 1);
  });

  it(`leaves the plain verdict below a ${VOLUME_RATIO_LIMIT}x difference`, () => {
    const [a, b] = aggregate(MANIFEST, [...config("A", 1, 7, 0), ...config("B", 0, 0, 0)]);
    const c = compareConfigs(a, b, "tune");
    assert.ok(c.verdict === "within spread" && c.volumeRatio === undefined);
  });
});
