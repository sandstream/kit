import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSkillspectorReport, SKILLSPECTOR_SOURCE } from "./skillspector-report.js";
import { skillspectorSarif } from "./skillspector-report.test-support.js";

const finding = {
  ruleId: "sample-rule",
  level: "error",
  properties: { "security-severity": "8.1" },
  message: { text: "Synthetic high severity observation" },
  locations: [
    { physicalLocation: { artifactLocation: { uri: "example.txt" }, region: { startLine: 3 } } },
  ],
};

describe("SkillSpector report outcomes", () => {
  it("attributes validated findings and records the declared coverage", () => {
    const report = readSkillspectorReport(skillspectorSarif({ results: [finding] }));
    assert.equal(report.status, "ok");
    const results = report.findings;
    assert.equal(results.length, 1);
    assert.equal(results[0].category, "supply-chain");
    assert.equal(results[0].severity, "high");
    assert.ok(results[0].name.startsWith(SKILLSPECTOR_SOURCE));
    assert.match(results[0].detail, /example\.txt:3/);
    assert.match(report.evidence.reportDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(report.evidence.runs[0].scannerVersion, "0.0.1-test");
  });

  it("only accepts an empty result from a complete invocation", () => {
    assert.equal(readSkillspectorReport(skillspectorSarif()).status, "ok");
    assert.equal(readSkillspectorReport("").status, "missing");
    assert.equal(readSkillspectorReport('{"version":"2.1.0","runs":[]}').status, "missing");
    assert.equal(readSkillspectorReport("not json").status, "malformed");
    assert.equal(
      readSkillspectorReport(skillspectorSarif({ version: "2.0.0" })).status,
      "unsupported",
    );
    assert.equal(
      readSkillspectorReport(skillspectorSarif({ coverage: null })).status,
      "unsupported",
    );
    assert.equal(
      readSkillspectorReport(skillspectorSarif({ executionSuccessful: false })).status,
      "partial",
    );
  });

  it("retains findings from partial coverage without returning a clean scan", () => {
    const report = readSkillspectorReport(
      skillspectorSarif({
        results: [finding],
        coverage: { status: "partial", isComplete: false, coveragePercent: 60 },
      }),
    );
    assert.equal(report.status, "partial");
    assert.equal(report.findings[0].severity, "high");
    assert.match(report.detail, /60%/);
  });

  it("requires complete coverage even when the report has no findings and execution succeeded", () => {
    const report = readSkillspectorReport(
      skillspectorSarif({
        coverage: { status: "complete_with_caveats", ledgerExceptionCount: 1 },
      }),
    );
    assert.equal(report.status, "caveats");
    assert.deepEqual(report.findings, []);
    assert.equal(
      readSkillspectorReport(skillspectorSarif({ coverage: { fullyInspectedFiles: 0 } })).status,
      "partial",
    );
  });
  it("refuses excluded files and malformed severity", () => {
    assert.equal(
      readSkillspectorReport(skillspectorSarif({ coverage: { scopeExclusionCount: 1 } })).status,
      "partial",
    );
    assert.equal(
      readSkillspectorReport(skillspectorSarif({ results: [{ ...finding, level: "unknown" }] }))
        .status,
      "malformed",
    );
  });
});
