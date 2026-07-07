import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLizardCsv,
  parseJscpdReport,
  parseSccByFile,
  checkStandards,
  collectStandardsKeys,
  complexityKey,
  sizeKey,
  DEFAULT_STANDARDS_THRESHOLDS,
  type GeneralScan,
} from "./check-standards.js";

describe("check-standards — parseLizardCsv", () => {
  it("maps function rows to complexity findings and skips non-rows", () => {
    // lizard --csv columns: nloc,CCN,token,param,length,location,file,function,long_name,start,end
    const csv = [
      '5,3,40,2,7,"foo@1-7@src/a.ts",src/a.ts,foo,"foo(a, b)",1,7',
      '80,22,600,4,120,"big@10-130@src/b.ts",src/b.ts,big,"big(w, x, y, z)",10,130',
      "", // blank
      "not,enough,cols",
    ].join("\n");
    const found = parseLizardCsv(csv);
    assert.equal(found.length, 2);
    assert.deepEqual(found[0], { file: "src/a.ts", fn: "foo", ccn: 3, length: 7 });
    assert.deepEqual(found[1], { file: "src/b.ts", fn: "big", ccn: 22, length: 120 });
  });

  it("handles quoted fields that contain commas", () => {
    const csv = '10,5,80,3,20,"m@1-20@src/c.ts","src/c,weird.ts","fn,name","long, name",1,20';
    const found = parseLizardCsv(csv);
    assert.equal(found.length, 1);
    assert.equal(found[0].file, "src/c,weird.ts");
    assert.equal(found[0].fn, "fn,name");
    assert.equal(found[0].ccn, 5);
  });
});

describe("check-standards — parseJscpdReport", () => {
  it("reads total percentage and dedupes/sorts clone pairs", () => {
    const json = JSON.stringify({
      statistics: { total: { percentage: 7.5 } },
      duplicates: [
        { firstFile: { name: "src/b.ts" }, secondFile: { name: "src/a.ts" } },
        { firstFile: { name: "src/a.ts" }, secondFile: { name: "src/b.ts" } }, // same pair, reversed
        { firstFile: { name: "src/c.ts" }, secondFile: { name: "src/d.ts" } },
      ],
    });
    const r = parseJscpdReport(json);
    assert.equal(r.percentage, 7.5);
    assert.deepEqual(r.pairs, ["src/a.ts|src/b.ts", "src/c.ts|src/d.ts"]);
  });

  it("is tolerant of an empty or malformed report", () => {
    assert.deepEqual(parseJscpdReport("{}"), { percentage: 0, pairs: [] });
    assert.deepEqual(parseJscpdReport("not json"), { percentage: 0, pairs: [] });
  });
});

describe("check-standards — parseSccByFile", () => {
  it("flattens per-language Files arrays to {file,lines}", () => {
    const json = JSON.stringify([
      { Name: "TypeScript", Files: [{ Location: "src/a.ts", Lines: 120 }] },
      { Name: "Go", Files: [{ Location: "main.go", Lines: 900 }] },
    ]);
    const found = parseSccByFile(json);
    assert.deepEqual(found, [
      { file: "src/a.ts", lines: 120 },
      { file: "main.go", lines: 900 },
    ]);
  });

  it("is tolerant of malformed input", () => {
    assert.deepEqual(parseSccByFile("nope"), []);
    assert.deepEqual(parseSccByFile("{}"), []);
  });
});

// A scan where everything is under the default thresholds.
const CLEAN_SCAN: GeneralScan = {
  complexity: { findings: [{ file: "src/a.ts", fn: "foo", ccn: 3, length: 20 }], didNotRun: false },
  duplication: { report: { percentage: 1.2, pairs: [] }, didNotRun: false },
  size: { findings: [{ file: "src/a.ts", lines: 100 }], didNotRun: false },
};

// A scan that breaches every threshold.
const DIRTY_SCAN: GeneralScan = {
  complexity: {
    findings: [{ file: "src/big.ts", fn: "monster", ccn: 40, length: 300 }],
    didNotRun: false,
  },
  duplication: {
    report: { percentage: 12, pairs: ["src/a.ts|src/b.ts"] },
    didNotRun: false,
  },
  size: { findings: [{ file: "src/huge.ts", lines: 1200 }], didNotRun: false },
};

describe("check-standards — checkStandards gating", () => {
  it("passes cleanly when all metrics are under threshold", async () => {
    const r = await checkStandards({ scan: CLEAN_SCAN });
    assert.equal(r.length, 3);
    assert.ok(r.every((x) => x.status === "pass"));
  });

  it("warns (not fails) on net-new findings by default", async () => {
    const r = await checkStandards({ scan: DIRTY_SCAN });
    assert.ok(r.every((x) => x.status === "warn"));
    assert.ok(r.every((x) => x.status !== "fail"));
    // the complexity finding is surfaced with its function
    const complexity = r.find((x) => x.name.startsWith("complexity"));
    assert.match(complexity?.files?.[0] ?? "", /monster/);
  });

  it("FAILS net-new findings under --enforce", async () => {
    const r = await checkStandards({ scan: DIRTY_SCAN, enforce: true });
    assert.ok(r.every((x) => x.status === "fail"));
    assert.ok(r.every((x) => x.severity === "high"));
  });

  it("downgrades baseline-frozen findings to a low warn (never fails, even under enforce)", async () => {
    const r = await checkStandards({
      scan: DIRTY_SCAN,
      enforce: true,
      baseline: {
        complexity: [complexityKey({ file: "src/big.ts", fn: "monster" })],
        duplication: ["src/a.ts|src/b.ts"],
        size: [sizeKey({ file: "src/huge.ts" })],
      },
    });
    // complexity + size are fully baselined → low warn.
    const complexity = r.find((x) => x.name.startsWith("complexity"));
    const size = r.find((x) => x.name.startsWith("file size"));
    assert.equal(complexity?.status, "warn");
    assert.equal(complexity?.severity, "low");
    assert.equal(size?.status, "warn");
    assert.equal(size?.severity, "low");
    // the sole offending clone pair is baselined → the over-threshold % is accepted
    // debt → frozen warn, not a fail (freezing the pair accepts the duplication).
    const dup = r.find((x) => x.name.startsWith("duplication"));
    assert.equal(dup?.status, "warn");
    assert.equal(dup?.severity, "low");
  });

  it("a NET-NEW clone pair re-fails duplication under enforce even with an old pair frozen", async () => {
    const scan: GeneralScan = {
      ...DIRTY_SCAN,
      duplication: {
        report: { percentage: 12, pairs: ["src/a.ts|src/b.ts", "src/new1.ts|src/new2.ts"] },
        didNotRun: false,
      },
    };
    const r = await checkStandards({
      scan,
      enforce: true,
      baseline: { duplication: ["src/a.ts|src/b.ts"] },
    });
    const dup = r.find((x) => x.name.startsWith("duplication"));
    assert.equal(dup?.status, "fail");
    assert.match(dup?.files?.[0] ?? "", /new1/);
  });

  it("respects overridden thresholds", async () => {
    // raise the ceilings above the dirty values → all pass
    const r = await checkStandards({
      scan: DIRTY_SCAN,
      thresholds: {
        maxComplexity: 50,
        maxFunctionLines: 400,
        maxFileLines: 2000,
        maxDuplicationPct: 20,
      },
    });
    assert.ok(r.every((x) => x.status === "pass"));
  });

  it("a tool that could not run is a setup gap: warn by default, fail under --enforce", async () => {
    const gapScan: GeneralScan = {
      complexity: { findings: [], didNotRun: true },
      duplication: { report: { percentage: 0, pairs: [] }, didNotRun: true },
      size: { findings: [], didNotRun: true },
    };
    const warn = await checkStandards({ scan: gapScan });
    assert.ok(warn.every((x) => x.status === "warn" && x.didNotRun === true));

    const fail = await checkStandards({ scan: gapScan, enforce: true });
    assert.ok(fail.every((x) => x.status === "fail" && x.didNotRun === true));
  });
});

describe("check-standards — collectStandardsKeys", () => {
  it("returns empty slices when the general tools are absent (nothing to freeze)", async () => {
    // lizard/jscpd/scc are not installed in this environment → didNotRun → empty.
    const keys = await collectStandardsKeys(process.cwd());
    assert.deepEqual(keys, { complexity: [], duplication: [], size: [] });
  });
});

describe("check-standards — defaults", () => {
  it("ships conservative calibrated thresholds", () => {
    assert.equal(DEFAULT_STANDARDS_THRESHOLDS.maxComplexity, 15);
    assert.equal(DEFAULT_STANDARDS_THRESHOLDS.maxFunctionLines, 80);
    assert.equal(DEFAULT_STANDARDS_THRESHOLDS.maxFileLines, 600);
    assert.equal(DEFAULT_STANDARDS_THRESHOLDS.maxDuplicationPct, 5);
  });
});
