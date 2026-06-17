import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSemgrepResults, citationFromMetadata } from "./semgrep-ingest.js";

describe("semgrep ingest", () => {
  it("parses results into normalized, cited findings (CWE)", () => {
    const json = {
      results: [
        {
          check_id: "javascript.lang.security.audit.xss.template-string",
          path: "src/app.ts",
          start: { line: 42 },
          extra: {
            message: "Potential XSS via template string.",
            severity: "ERROR",
            metadata: {
              cwe: ["CWE-79: Improper Neutralization of Input During Web Page Generation"],
              owasp: ["A03:2021 - Injection"],
            },
          },
        },
      ],
    };
    const f = parseSemgrepResults(json);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.severity, "error");
    assert.equal(f[0]?.file, "src/app.ts");
    assert.equal(f[0]?.line, 42);
    assert.equal(f[0]?.ruleId, "javascript.lang.security.audit.xss.template-string");
    assert.equal(f[0]?.rule?.id, "CWE-79");
    assert.equal(f[0]?.rule?.source, "cwe");
  });

  it("falls back to OWASP when no CWE is present", () => {
    const r = citationFromMetadata({ owasp: ["A01:2021 - Broken Access Control"] });
    assert.equal(r?.id, "OWASP-A01");
    assert.equal(r?.source, "owasp");
  });

  it("returns no citation when metadata has neither CWE nor OWASP", () => {
    assert.equal(citationFromMetadata({ references: ["x"] }), null);
    assert.equal(citationFromMetadata(null), null);
  });

  it("handles malformed or empty input safely", () => {
    assert.deepEqual(parseSemgrepResults(null), []);
    assert.deepEqual(parseSemgrepResults({}), []);
    assert.deepEqual(parseSemgrepResults({ results: "nope" }), []);
    // an entry without a check_id is skipped
    assert.deepEqual(parseSemgrepResults({ results: [{ path: "x" }] }), []);
  });

  it("normalizes WARNING/INFO severities", () => {
    const f = parseSemgrepResults({
      results: [
        { check_id: "a", path: "x", extra: { severity: "WARNING" } },
        { check_id: "b", path: "y", extra: { severity: "INFO" } },
      ],
    });
    assert.equal(f[0]?.severity, "warning");
    assert.equal(f[1]?.severity, "info");
  });
});
