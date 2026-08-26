import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ingestAisleNanoOutputDir,
  normalizeAisleNanoFindings,
  parseAisleNanoSummaryJson,
  parseAisleNanoTriageJson,
  recordAisleNanoFindings,
} from "./scan.js";

const TRIAGE = JSON.stringify([
  {
    file: "lib/vtls.c",
    finding_title: "mTLS connection reuse auth bypass",
    verdict: "VALID",
    confidence: 0.83,
    verdicts_str: "VVI→V",
    triage_md: "/tmp/aisle/triages/T0001.md",
  },
  {
    file: "lib/http2.c",
    finding_title: "Possible UAF in cleanup",
    verdict: "INVALID",
    confidence: 0.1,
  },
  {
    file: "lib/ssh.c",
    finding_title: "Uncertain host key mismatch",
    verdict: "UNCERTAIN",
    confidence: 0.4,
  },
]);

const SUMMARY = JSON.stringify({
  timestamp: "2026-08-26T12:00:00",
  target: "/work/curl",
  model: "gpt-5.4-nano",
  per_file: [
    {
      file: "lib/vtls.c",
      severities: { critical: 0, high: 0, medium: 1, low: 0, informational: 0 },
    },
  ],
});

describe("aisle nano-analyzer plugin", () => {
  it("parses triage.json and summary.json", () => {
    const triage = parseAisleNanoTriageJson(TRIAGE);
    const summary = parseAisleNanoSummaryJson(SUMMARY);
    assert.equal(triage.length, 3);
    assert.equal(triage[0]?.verdict, "VALID");
    assert.equal(triage[0]?.confidence, 0.83);
    assert.equal(summary.target, "/work/curl");
    assert.equal(summary.per_file?.[0]?.severities?.medium, 1);
  });

  it("normalizes only VALID findings by default", () => {
    const triage = parseAisleNanoTriageJson(TRIAGE);
    const summary = parseAisleNanoSummaryJson(SUMMARY);
    const findings = normalizeAisleNanoFindings(triage, { summary });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.source, "aisle");
    assert.equal(findings[0]?.scanner, "nano-analyzer");
    assert.equal(findings[0]?.severity, "medium");
    assert.equal(findings[0]?.file, "lib/vtls.c");
    assert.equal(findings[0]?.model, "gpt-5.4-nano");
  });

  it("falls back to high severity for validated findings when nano output lacks severity", () => {
    const findings = normalizeAisleNanoFindings(parseAisleNanoTriageJson(TRIAGE));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "high");
  });

  it("can include rejected findings as low-severity receipts", () => {
    const findings = normalizeAisleNanoFindings(parseAisleNanoTriageJson(TRIAGE), {
      includeRejected: true,
    });
    assert.equal(findings.length, 3);
    assert.equal(findings[1]?.severity, "low");
    assert.equal(findings[1]?.verdict, "INVALID");
  });

  it("filters valid findings below the configured confidence floor", () => {
    const findings = normalizeAisleNanoFindings(parseAisleNanoTriageJson(TRIAGE), {
      minConfidence: 0.9,
    });
    assert.equal(findings.length, 0);
  });

  it("throws structured errors on invalid JSON", () => {
    assert.throws(
      () => parseAisleNanoTriageJson("not json"),
      /Invalid AISLE nano-analyzer triage JSON/,
    );
    assert.throws(
      () => parseAisleNanoSummaryJson("not json"),
      /Invalid AISLE nano-analyzer summary JSON/,
    );
  });

  it("records normalized findings to .kit-scan-results.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-aisle-"));
    try {
      const res = await recordAisleNanoFindings(parseAisleNanoTriageJson(TRIAGE), dir, {
        summary: parseAisleNanoSummaryJson(SUMMARY),
      });
      assert.equal(res.written, 1);
      const line = JSON.parse(readFileSync(join(dir, ".kit-scan-results.jsonl"), "utf-8").trim());
      assert.equal(line.source, "aisle");
      assert.equal(line.scanner, "nano-analyzer");
      assert.equal(line.severity, "medium");
      assert.equal(line.id, "aisle-nano:lib/vtls.c:mtls-connection-reuse-auth-bypass");
      assert.equal(line.target, "/work/curl");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ingests a nano-analyzer output directory", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "aisle-output-"));
    const repoDir = mkdtempSync(join(tmpdir(), "kit-aisle-"));
    try {
      mkdirSync(join(outDir, "triages"));
      writeFileSync(join(outDir, "triage.json"), TRIAGE);
      writeFileSync(join(outDir, "summary.json"), SUMMARY);
      const res = await ingestAisleNanoOutputDir(outDir, repoDir);
      assert.equal(res.written, 1);
      const line = JSON.parse(
        readFileSync(join(repoDir, ".kit-scan-results.jsonl"), "utf-8").trim(),
      );
      assert.equal(line.title, "mTLS connection reuse auth bypass");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
