import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ingestStrict } from "./ingest.js";

describe("SARIF: repeated results collapse by fingerprint", () => {
  const result = (k: number, fingerprint?: Record<string, unknown>, level = "warning") => ({
    ruleId: `R${k % 3}`,
    level,
    message: { text: `finding ${k}` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: `src/f${k}.c` },
          region: { startLine: 10 + k },
        },
      },
    ],
    ...fingerprint,
  });
  const report = (results: unknown[]) =>
    JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "t" } }, results }] });
  const findingsOf = (json: string) => {
    const outcome = ingestStrict("sarif", json);
    assert.ok(outcome.ok);
    return outcome.findings as Array<{ fingerprint?: string; occurrences?: number }>;
  };

  it("turns 1,000 results over 250 partial fingerprints into 250 findings of 4 occurrences", () => {
    const results = Array.from({ length: 1000 }, (_, i) =>
      result(i % 250, { partialFingerprints: { primaryLocationLineHash: `fp${i % 250}` } }),
    );
    const findings = findingsOf(report(results));
    assert.equal(findings.length, 250);
    assert.ok(findings.every((f) => f.occurrences === 4));
    assert.equal(findings[0].fingerprint, "partialFingerprints:primaryLocationLineHash=fp0");
  });

  it("prefers `fingerprints`, and keeps the highest severity of the copies", () => {
    const findings = findingsOf(
      report([
        result(1, { fingerprints: { v1: "A" }, partialFingerprints: { h: "1" } }, "note"),
        result(1, { fingerprints: { v1: "A" }, partialFingerprints: { h: "2" } }, "error"),
      ]),
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fingerprint, "fingerprints:v1=A");
    assert.equal((findings[0] as { severity?: string }).severity, "high");
    assert.equal(findings[0].occurrences, 2);
  });

  it("falls back to rule, location and message, so distinct results at one line stay apart", () => {
    const twice = [result(7), result(7)];
    const other = { ...result(7), message: { text: "another package" } };
    const findings = findingsOf(report([...twice, other]));
    assert.deepEqual(
      findings.map((f) => f.occurrences),
      [2, 1],
    );
  });
});
