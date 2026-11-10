import assert from "node:assert/strict";
import { it } from "node:test";
import { runToolHealthFixture } from "./standards-tool-health.test-support.js";

const safeSource = "def safe():\n    return 1\n";
const safeCsv = '2,1,7,0,2,"safe@1-2@main.py",main.py,safe,"safe()",1,2\n';
const branchySource = safeSource + "\ndef branchy(value):\n    if value: return 1\n    return 0\n";

it("rejects a malformed successful CSV report instead of counting zero functions", () => {
  const result = runToolHealthFixture({
    source: safeSource,
    csv: "not,a,function,report\n",
    exitCode: 0,
  });
  assert.equal(result.gate.ok, false);
  const complexity = result.gate.checks.find((check) => check.name.startsWith("complexity"));
  assert.equal(complexity?.didNotRun, true);
});

it("does not publish a baseline from malformed CSV after a valid function row", () => {
  const result = runToolHealthFixture({
    source: branchySource,
    csv: safeCsv + "not,a,function,report\n",
    exitCode: 0,
    freeze: true,
  });
  assert.equal(result.gate.ok, false);
  assert.equal(result.gate.summary.setupGaps, 1);
  assert.equal(result.freezeAccepted, false);
  assert.equal(result.baselineAfter, result.baselineBefore);
});

const invalidCsvReports = [
  ["unterminated quotes", '2,1,7,0,2,"safe@1-2@main.py,main.py,safe,safe(),1,2'],
  ["text after a quoted field", safeCsv.replace('"safe()"', '"safe()"extra')],
  ["a quote inside an unquoted field", safeCsv.replace(",main.py,", ',ma"in.py,')],
  ["a missing complexity", safeCsv.replace("2,1,", "2,,")],
  ["a fractional complexity", safeCsv.replace("2,1,", "2,1.5,")],
  ["an unsafe complexity", safeCsv.replace("2,1,", "2,9007199254740992,")],
  ["a negative complexity", safeCsv.replace("2,1,", "2,-1,")],
  ["an inconsistent function span", safeCsv.replace(",1,2\n", ",1,3\n")],
];
for (const [name, csv] of invalidCsvReports) {
  it(`refuses a successful Lizard report with ${name}`, () => {
    const result = runToolHealthFixture({ source: safeSource, csv, exitCode: 0 });
    assert.equal(result.gate.ok, false);
    assert.equal(result.gate.summary.setupGaps, 1);
    assert.equal(
      result.gate.checks.find((check) => check.name.startsWith("complexity"))?.didNotRun,
      true,
    );
  });
}

it("accepts CSV quotes, commas, CRLF records and line breaks inside quoted fields", () => {
  const csv =
    '2,1,7,0,2,"safe@1-2@main.py","file,with""quotes\nand-newline.py",safe,"safe()",1,2\r\n';
  const result = runToolHealthFixture({ source: safeSource, csv, exitCode: 0 });
  assert.equal(result.gate.ok, true);
  assert.equal(result.gate.summary.setupGaps, 0);
});
