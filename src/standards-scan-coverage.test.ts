import assert from "node:assert/strict";
import { it } from "node:test";
import { runToolHealthFixture } from "./standards-tool-health.test-support.js";

const safeSource = "def safe():\n    return 1\n";
const safeCsv = '2,1,7,0,2,"safe@1-2@main.py",main.py,safe,"safe()",1,2\n';
const jscpd = (sources: unknown): string =>
  JSON.stringify({
    statistics: { total: { lines: 2, sources, clones: 0, percentage: 0 }, formats: {} },
    duplicates: [],
  });

it("accepts scc and jscpd reports that cover a project with measured functions", () => {
  const { gate } = runToolHealthFixture({ source: safeSource, csv: safeCsv, exitCode: 0 });
  assert.equal(gate.ok, true);
  assert.equal(gate.summary.setupGaps, 0);
});

it("does not certify file size when scc lists no file but lizard measured a function", (t) => {
  const { gate } = runToolHealthFixture({
    source: safeSource,
    csv: safeCsv,
    exitCode: 0,
    sccReport: "[]",
  });
  t.diagnostic(JSON.stringify(gate));
  assert.equal(gate.ok, false);
  const size = gate.checks.find((check) => check.name.startsWith("file size"));
  assert.equal(size?.status, "fail");
  assert.equal(size?.didNotRun, true);
  assert.equal(gate.summary.setupGaps, 1);
  assert.equal(gate.summary.passed, 2);
});

for (const [name, sources] of [
  ["zero sources", 0],
  ["no source count", undefined],
  ["an invalid source count", "one"],
] as const) {
  it(`does not certify duplication when jscpd reports ${name} but lizard measured a function`, (t) => {
    const { gate } = runToolHealthFixture({
      source: safeSource,
      csv: safeCsv,
      exitCode: 0,
      jscpdReport: jscpd(sources),
    });
    t.diagnostic(JSON.stringify(gate));
    assert.equal(gate.ok, false);
    const duplication = gate.checks.find((check) => check.name.startsWith("duplication"));
    assert.equal(duplication?.status, "fail");
    assert.equal(duplication?.didNotRun, true);
    assert.equal(gate.summary.setupGaps, 1);
    assert.equal(gate.summary.passed, 2);
  });
}

it("still accepts empty reports when no tool measured anything", () => {
  const { gate } = runToolHealthFixture({ source: "", csv: "", exitCode: 0 });
  assert.equal(gate.ok, true);
  assert.equal(gate.summary.setupGaps, 0);
});
