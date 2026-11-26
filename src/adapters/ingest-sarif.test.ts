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

  it("keeps failures and records review as a warning", () => {
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
        ["dast: c", "warn"],
        ["dast: d", "fail"],
      ],
    );
  });
});

describe("ingestStrict: SARIF review and suppressions", () => {
  const log = (results: unknown[]) =>
    JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "t" } }, results }] });

  it("reads the five SARIF result states as two findings, one of them a warning", () => {
    const outcome = ingestStrict(
      "sarif",
      log([
        { ruleId: "R0", kind: "pass", message: { text: "pass" } },
        { ruleId: "R0", kind: "notApplicable", message: { text: "na" } },
        { ruleId: "R0", kind: "review", message: { text: "review" } },
        {
          ruleId: "R0",
          level: "error",
          message: { text: "sup" },
          suppressions: [{ status: "accepted" }],
        },
        {
          ruleId: "R0",
          level: "error",
          message: { text: "unchanged" },
          baselineState: "unchanged",
        },
      ]),
    );
    assert.ok(outcome.ok);
    assert.deepEqual(
      outcome.findings.map((f) => [f.detail, f.status]),
      [
        ["review", "warn"],
        ["unchanged", "fail"],
      ],
    );
    assert.equal(outcome.suppressed, 1);
    assert.equal(outcome.coverage, undefined);
  });

  it("suppresses only when every suppression is accepted or has no status", () => {
    const outcome = ingestStrict(
      "sarif",
      log([
        { ruleId: "none", suppressions: [{ kind: "inSource" }] },
        { ruleId: "review", suppressions: [{ status: "underReview" }] },
        { ruleId: "rejected", suppressions: [{ status: "rejected" }] },
        { ruleId: "mixed", suppressions: [{ status: "accepted" }, { status: "rejected" }] },
        { ruleId: "empty", suppressions: [] },
      ]),
    );
    assert.ok(outcome.ok);
    assert.deepEqual(
      outcome.findings.map((f) => [f.name, f.status]),
      [
        ["t: review", "fail"],
        ["t: rejected", "fail"],
        ["t: mixed", "fail"],
        ["t: empty", "fail"],
      ],
    );
    assert.equal(outcome.suppressed, 1);
    const plain = ingestStrict("sarif", log([{ ruleId: "x" }]));
    assert.ok(plain.ok && plain.suppressed === undefined);
  });
});
