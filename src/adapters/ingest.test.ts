import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSarif, parseOsv, ingest, ingestStrict } from "./ingest.js";

const sarif = JSON.stringify({
  runs: [
    {
      tool: {
        driver: {
          name: "semgrep",
          rules: [
            {
              id: "sql-injection",
              properties: { tags: ["security", "external/cwe/cwe-89"], "security-severity": "9.1" },
            },
            { id: "weak-hash", properties: { tags: ["CWE-328"] } },
          ],
        },
      },
      results: [
        {
          ruleId: "sql-injection",
          level: "error",
          message: { text: "Possible SQL injection" },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: "src/db.ts" },
                region: { startLine: 42 },
              },
            },
          ],
        },
        { ruleId: "weak-hash", level: "warning", message: { text: "MD5 used" } },
      ],
    },
  ],
});

const osv = JSON.stringify({
  results: [
    {
      packages: [
        {
          package: { name: "lodash", ecosystem: "npm", version: "4.17.11" },
          vulnerabilities: [
            {
              id: "GHSA-jf85-cpcp-j695",
              summary: "Prototype pollution in lodash",
              database_specific: { severity: "HIGH" },
            },
          ],
        },
      ],
    },
  ],
});

describe("parseSarif", () => {
  it("maps results to findings with CVSS-derived severity + CWE citation + location", () => {
    const out = parseSarif(sarif);
    assert.equal(out.length, 2);
    const sqli = out[0];
    assert.equal(sqli.category, "exposure");
    assert.equal(sqli.name, "semgrep: sql-injection");
    assert.equal(sqli.severity, "critical"); // security-severity 9.1
    assert.match(sqli.detail, /src\/db\.ts:42/);
    assert.equal(sqli.rule?.id, "CWE-89");
  });

  it("falls back to level→severity when no security-severity, and reads CWE-NNN tags", () => {
    const weak = parseSarif(sarif)[1];
    assert.equal(weak.severity, "medium"); // level warning
    assert.equal(weak.rule?.id, "CWE-328");
  });

  it("returns [] on garbage", () => {
    assert.deepEqual(parseSarif("not json"), []);
    assert.deepEqual(parseSarif(JSON.stringify({})), []);
  });
});

describe("parseOsv", () => {
  it("maps package vulnerabilities to dependency findings with OWASP-A06 citation", () => {
    const out = parseOsv(osv);
    assert.equal(out.length, 1);
    assert.equal(out[0].category, "dependency");
    assert.equal(out[0].name, "lodash@4.17.11: GHSA-jf85-cpcp-j695");
    assert.equal(out[0].severity, "high");
    assert.equal(out[0].rule?.id, "OWASP-A06");
    assert.match(out[0].detail, /Prototype pollution/);
  });

  it("returns [] on garbage", () => {
    assert.deepEqual(parseOsv("nope"), []);
  });
});

describe("ingest dispatch", () => {
  it("routes by format; unknown → []", () => {
    assert.equal(ingest("sarif", sarif).length, 2);
    assert.equal(ingest("osv", osv).length, 1);
    // @ts-expect-error unknown format
    assert.deepEqual(ingest("nope", sarif), []);
  });
});

describe("ingestStrict", () => {
  it("parses valid input into findings (ok:true)", () => {
    const a = ingestStrict("sarif", sarif);
    assert.equal(a.ok, true);
    assert.ok(a.ok && a.findings.length === 2);
    const b = ingestStrict("osv", osv);
    assert.ok(b.ok && b.findings.length === 1);
  });

  it("accepts a valid but EMPTY report as ok:true with no findings", () => {
    const a = ingestStrict("sarif", JSON.stringify({ runs: [] }));
    assert.ok(a.ok && a.findings.length === 0);
    const b = ingestStrict("osv", JSON.stringify({ results: [] }));
    assert.ok(b.ok && b.findings.length === 0);
  });

  it("rejects malformed JSON (ok:false) — the masked-failure case", () => {
    assert.equal(ingestStrict("sarif", "panic: boom").ok, false);
    assert.equal(ingestStrict("osv", "not json").ok, false);
  });

  it("rejects valid JSON of the wrong shape (ok:false)", () => {
    // parses fine, but it's an error blob, not a SARIF/OSV report
    assert.equal(ingestStrict("sarif", JSON.stringify({ error: "no db" })).ok, false);
    assert.equal(ingestStrict("osv", JSON.stringify({ runs: [] })).ok, false);
  });
});
