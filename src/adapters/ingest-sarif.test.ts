import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSarif } from "./ingest-sarif.js";
import { ingestStrict } from "./ingest.js";

describe("parseSarif: result kind", () => {
  const log = (results: unknown[]) =>
    JSON.stringify({ runs: [{ tool: { driver: { name: "dast" } }, results }] });

  it("reads a pass, notApplicable or informational result as no failure", () => {
    const out = parseSarif(
      log([
        { ruleId: "checked-ok", kind: "pass", level: "none" },
        { ruleId: "not-relevant", kind: "notApplicable" },
        { ruleId: "fyi", kind: "informational", level: "note" },
      ]),
    );
    assert.deepEqual(out, []);
    const strict = ingestStrict("sarif", log([{ ruleId: "checked-ok", kind: "pass" }]));
    assert.ok(strict.ok && strict.findings.length === 0);
  });

  it("keeps fail, open (Nuclei marks every result open), review and an absent kind as failures", () => {
    const out = parseSarif(
      log([
        { ruleId: "a", kind: "fail", level: "error" },
        { ruleId: "b", kind: "open", level: "note" },
        { ruleId: "c", kind: "review" },
        { ruleId: "d" },
        { ruleId: "e", kind: "pass" },
      ]),
    );
    assert.deepEqual(
      out.map((f) => [f.name, f.status]),
      [
        ["dast: a", "fail"],
        ["dast: b", "fail"],
        ["dast: c", "fail"],
        ["dast: d", "fail"],
      ],
    );
  });
});
