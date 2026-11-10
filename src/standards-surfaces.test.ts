import assert from "node:assert/strict";
import { it } from "node:test";
import { runToolHealthFixture } from "./standards-tool-health.test-support.js";

const source = "def safe():\n    return 1\n";
const csv = '2,1,7,0,2,"safe@1-2@main.py",main.py,safe,"safe()",1,2\n';

it("the actual CLI reports malformed complexity evidence as a failed enforced gate", () => {
  const result = runToolHealthFixture({ source, csv: "invalid", exitCode: 0, surface: "cli" });
  assert.equal(result.cli?.exit, 1);
  assert.equal(result.surface?.ok, false);
  assert.equal(result.surface?.summary.setupGaps, 1);
  assert.equal(
    result.surface?.checks.find((check) => check.name.startsWith("complexity"))?.didNotRun,
    true,
  );
});

it("the actual CLI can pass valid measured evidence", () => {
  const result = runToolHealthFixture({ source, csv, exitCode: 0, surface: "cli" });
  assert.equal(result.cli?.exit, 0);
  assert.equal(result.surface?.ok, true);
  assert.equal(result.surface?.summary.setupGaps, 0);
});

it("the actual freeze command preserves the baseline after malformed complexity evidence", () => {
  const result = runToolHealthFixture({
    source,
    csv: "invalid",
    exitCode: 0,
    surface: "cli",
    freeze: true,
  });
  assert.equal(result.cli?.exit, 1);
  assert.match(result.cli?.stderr ?? "", /Cannot freeze standards.*incomplete/);
  assert.equal(result.baselineAfter, result.baselineBefore);
});

it("the human CLI distinguishes incomplete evidence from missing tool installation", () => {
  const result = runToolHealthFixture({
    source,
    csv: "invalid",
    exitCode: 0,
    surface: "cli",
    text: true,
  });
  assert.equal(result.cli?.exit, 0, "the default remains advisory; enforcement is explicit");
  assert.match(result.cli?.stdout ?? "", /invalid report|incomplete/);
  assert.doesNotMatch(
    result.cli?.stdout ?? "",
    /setup gaps are un-provisioned tools, not failures/,
  );
});

for (const [label, report, expected] of [
  ["invalid", "invalid", false],
  ["valid", csv, true],
] as const) {
  it(`the MCP standards stage preserves ${label} evidence and its gate result`, () => {
    const result = runToolHealthFixture({ source, csv: report, exitCode: 0, surface: "mcp" });
    const review = result.mcp;
    assert.ok(review);
    assert.equal(review.ok, expected);
    assert.deepEqual(
      review.stages.map((stage) => stage.stage),
      ["standards"],
    );
    assert.equal(review.stages[0].ok, expected);
    assert.equal(
      review.stages[0].findings.some((check) => check.didNotRun),
      !expected,
    );
  });
}
