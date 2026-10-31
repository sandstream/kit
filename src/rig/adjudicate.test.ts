import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjudicate, adjudicateRun, distance, nearest } from "./adjudicate.js";
import { parseFindings, type Finding, type RunMark } from "./findings.js";
import { parseManifest, type RigDefect } from "./manifest.js";

const D1: RigDefect = {
  id: "d1",
  file: "src/auth.ts",
  line_start: 40,
  line_end: 42,
  kind: "missing-check",
  split: "tune",
  patch: "defects/d1.diff",
};
const D2: RigDefect = { ...D1, id: "d2", line_start: 50, line_end: 50 };

const MARK: RunMark = {
  run: "r1",
  config: "A",
  target: "d1",
  model: "m",
  model_version: "1",
  date: "2026-10-31",
};

const at = (line: number, file = "src/auth.ts"): Finding => ({
  ...MARK,
  file,
  line,
  claim: "x",
  severity: "high",
});

describe("distance", () => {
  it("is 0 inside the range, the gap within tolerance, and null outside it or in another file", () => {
    assert.equal(distance(at(41), D1, 3), 0);
    assert.equal(distance(at(37), D1, 3), 3);
    assert.equal(distance(at(45), D1, 3), 3);
    assert.equal(distance(at(36), D1, 3), null);
    assert.equal(distance(at(46), D1, 3), null);
    assert.equal(distance(at(41, "src/other.ts"), D1, 3), null);
    assert.equal(distance(at(43), D1, 0), null);
  });
});

describe("nearest", () => {
  it("picks the nearer defect, and the lower id on a tie", () => {
    assert.equal(nearest(at(44), [D1, D2], 6)?.id, "d1");
    assert.equal(nearest(at(48), [D1, D2], 6)?.id, "d2");
    assert.equal(nearest(at(46), [D2, D1], 6)?.id, "d1");
    assert.equal(nearest(at(30), [D1, D2], 3), null);
  });
});

describe("adjudicateRun", () => {
  it("catches a defect at most once and counts the rest as duplicates", () => {
    const o = adjudicateRun(MARK, [at(41), at(42), at(100)], [D1], 3, "defect");
    assert.deepEqual(
      [o.caught, o.missed, o.duplicates, o.unmatched, o.falsePositives],
      [["d1"], [], 1, 1, 0],
    );
  });

  it("reports a miss when nothing lands within tolerance", () => {
    const o = adjudicateRun(MARK, [at(30)], [D1], 3, "defect");
    assert.deepEqual([o.caught, o.missed, o.unmatched], [[], ["d1"], 1]);
  });

  it("counts every finding on a control as a false positive", () => {
    const o = adjudicateRun({ ...MARK, target: "c1" }, [at(1), at(2)], [], 3, "control");
    assert.deepEqual([o.falsePositives, o.unmatched, o.caught], [2, 0, []]);
  });
});

describe("adjudicate", () => {
  const MANIFEST = parseManifest(`
[input]
repo = "acme/webapp"
commit = "${"b".repeat(40)}"
prompt = "p.md"

[[defect]]
id = "d1"
file = "src/auth.ts"
line_start = 40
line_end = 42
kind = "missing-check"
split = "tune"
patch = "d1.diff"

[[control]]
id = "c1"
patch = "c1.diff"
`);

  const row = (o: Record<string, unknown>): string =>
    JSON.stringify({ model: "m", model_version: "1", date: "2026-10-31", ...o });

  it("adjudicates defect runs, clean and noisy controls, and Windows-style paths", () => {
    const ingest = parseFindings(
      [
        row({
          run: "r2",
          config: "A",
          target: "d1",
          file: "src\\auth.ts",
          line: 43,
          claim: "x",
          severity: "high",
        }),
        row({ run: "r1", config: "A", target: "d1", none: true }),
        row({ run: "r1", config: "A", target: "c1", none: true }),
        row({
          run: "r2",
          config: "A",
          target: "c1",
          file: "src/a.ts",
          line: 1,
          claim: "y",
          severity: "low",
        }),
      ].join("\n"),
    );
    const { outcomes, unknownTargets } = adjudicate(MANIFEST, ingest);
    assert.deepEqual(unknownTargets, []);
    assert.deepEqual(
      outcomes.map((o) => [o.run, o.target, o.caught.length, o.missed.length, o.falsePositives]),
      [
        ["r1", "c1", 0, 0, 0],
        ["r1", "d1", 0, 1, 0],
        ["r2", "c1", 0, 0, 1],
        ["r2", "d1", 1, 0, 0],
      ],
    );
  });

  it("refuses to guess a run whose target is not in the manifest", () => {
    const ingest = parseFindings(row({ run: "r1", config: "A", target: "d9", none: true }));
    const { outcomes, unknownTargets } = adjudicate(MANIFEST, ingest);
    assert.equal(outcomes.length, 0);
    assert.deepEqual(
      unknownTargets.map((m) => m.target),
      ["d9"],
    );
  });
});
