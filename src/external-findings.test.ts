import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseExternalFindings,
  externalFindingResults,
  checkExternalFindings,
  EXTERNAL_FINDINGS_FILE,
} from "./external-findings.js";

describe("parseExternalFindings", () => {
  it("parses valid finding lines (case-insensitive severity, extra keys ignored)", () => {
    const text = [
      '{"source":"snyk","severity":"HIGH","id":"S-1","title":"t","package":"lodash","cvss":9}',
      '{"source":"sentrux","severity":"medium"}',
      "", // blank skipped
    ].join("\n");
    const { findings, malformed } = parseExternalFindings(text);
    assert.equal(malformed, 0);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].severity, "high");
    assert.equal(findings[0].source, "snyk");
    assert.equal(findings[0].package, "lodash");
  });

  it("counts malformed lines (bad json / non-object / array / missing source / bad severity)", () => {
    const text = [
      "not json",
      '"a string"',
      "[1,2,3]",
      '{"severity":"high"}', // no source
      '{"source":"x","severity":"nope"}', // bad severity
      '{"source":"  ","severity":"high"}', // blank source
    ].join("\n");
    const { findings, malformed } = parseExternalFindings(text);
    assert.equal(findings.length, 0);
    assert.equal(malformed, 6);
  });
});

describe("externalFindingResults (no-false-green)", () => {
  it("FAILS a source with high/critical, WARNs medium/low, and never emits pass", () => {
    const results = externalFindingResults({
      findings: [
        { source: "snyk", severity: "high" },
        { source: "snyk", severity: "low" },
        { source: "aigis", severity: "medium" },
      ],
      malformed: 0,
    });
    const snyk = results.find((r) => r.name === "external: snyk");
    const aigis = results.find((r) => r.name === "external: aigis");
    assert.equal(snyk?.status, "fail"); // worst = high → fail
    assert.equal(snyk?.severity, "high");
    assert.match(snyk?.detail ?? "", /1 high, 1 low/);
    assert.equal(aigis?.status, "warn"); // only medium → warn
    assert.ok(!results.some((r) => r.status === "pass"), "ingestion can never produce a pass");
    // deterministic sort by source
    assert.deepEqual(
      results.map((r) => r.name),
      ["external: aigis", "external: snyk"],
    );
  });

  it("a forged status/pass key in the line cannot green the gate (only severity drives it)", () => {
    // A hostile emitter tries to sneak a pass through. parse ignores unknown keys;
    // the only lever is `severity`, and a critical severity FAILS regardless.
    const { findings } = parseExternalFindings(
      '{"source":"evil","severity":"critical","status":"pass","ok":true}',
    );
    const [r] = externalFindingResults({ findings, malformed: 0 });
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
  });

  it("surfaces malformed lines as a low warn (never silent)", () => {
    const results = externalFindingResults({ findings: [], malformed: 3 });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "warn");
    assert.match(results[0].detail, /3 unparseable/);
  });
});

describe("checkExternalFindings (IO)", () => {
  it("returns [] when no results file is present (no-op)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    try {
      assert.deepEqual(await checkExternalFindings(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ingests a partner-written results file into per-source results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ext-"));
    try {
      writeFileSync(
        join(dir, EXTERNAL_FINDINGS_FILE),
        ['{"source":"snyk","severity":"critical","id":"S-9","package":"foo"}', "garbage line"].join(
          "\n",
        ),
      );
      const results = await checkExternalFindings(dir);
      const snyk = results.find((r) => r.name === "external: snyk");
      assert.equal(snyk?.status, "fail");
      assert.equal(snyk?.severity, "critical");
      assert.ok(
        results.some((r) => r.name === "external findings (parse)" && r.status === "warn"),
        "the garbage line is surfaced, not silently dropped",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
