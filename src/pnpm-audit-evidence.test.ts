import assert from "node:assert/strict";
import { it } from "node:test";
import { readPnpmAuditEvidence } from "./pnpm-audit-evidence.js";

// Report shapes observed with the pinned binaries against a disposable registry fixture.
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
const metadata = {
  vulnerabilities: counts,
  dependencies: 1,
  devDependencies: 1,
  optionalDependencies: 1,
  totalDependencies: 3,
};
const legacy = { actions: [], muted: [] };
const clean = { advisories: {}, metadata };
const ghsa = "GHSA-2222-3333-4444";
const row = {
  findings: [{ version: "7.0.0", paths: [".>is-number"] }],
  id: 123,
  title: "Fixture advisory",
  module_name: "is-number",
  vulnerable_versions: "<8.0.0",
  severity: "high",
  github_advisory_id: ghsa,
  url: `https://github.com/advisories/${ghsa}`,
};
const findings = {
  advisories: { 123: row },
  metadata: { ...metadata, vulnerabilities: { ...counts, high: 1 } },
};
const advisory = { id: ghsa, package: "is-number", severity: "high", title: row.title };

function read(doc: unknown, exitCode: number | null = 0, expectedEntries?: number) {
  return readPnpmAuditEvidence(
    { stdout: JSON.stringify(doc), stderr: "", exitCode },
    expectedEntries,
  );
}

it("accepts a clean legacy registry report and a clean bulk report", () => {
  const registryMetadata = {
    ...metadata,
    dependencies: 4,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: 4,
  };
  const nativeLegacy = { ...clean, ...legacy, metadata: registryMetadata };
  const expected = { advisories: [], evidenceStatus: "complete-empty" };
  assert.deepEqual(read(nativeLegacy), expected);
  assert.deepEqual(read(clean, 0, 3), expected);
});

it("accepts matching findings exits and reports baseline-compatible advisories", () => {
  assert.deepEqual(read({ ...findings, ...legacy }, 1), {
    advisories: [advisory],
    evidenceStatus: "complete",
  });
  const bulk = {
    ...row,
    github_advisory_id: ghsa.toLowerCase(),
    findings: [{ ...row.findings[0], dev: false, optional: false, bundled: false }],
  };
  assert.deepEqual(read({ ...findings, advisories: { 123: bulk } }, 1, 3), {
    advisories: [advisory],
    evidenceStatus: "complete",
  });
});

it("rejects a message, absent output, malformed JSON, and a different audit format", () => {
  const cases = [
    ['{"message":"audit report missing"}', "malformed"],
    ["", "missing"],
    ["[]", "malformed"],
    ['{"advisories":', "malformed"],
    ['{"auditReportVersion":2,"vulnerabilities":{},"metadata":{}}', "unsupported"],
  ];
  for (const [stdout, status] of cases) {
    const result = readPnpmAuditEvidence({ stdout, stderr: "", exitCode: 0 });
    assert.equal(result.evidenceStatus, status, stdout);
    assert.ok(result.error);
    assert.deepEqual(result.advisories, []);
  }
});

it("rejects registry errors in the native JSON and suppressed text forms", () => {
  const diagnostic = "The audit endpoint (at https://example.invalid/) responded with 503";
  const result = read({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", message: diagnostic } }, 1);
  const ignored = readPnpmAuditEvidence({ stdout: diagnostic, stderr: "", exitCode: 0 });
  for (const outcome of [result, ignored]) {
    assert.equal(outcome.evidenceStatus, "unavailable");
    assert.ok(outcome.error);
    assert.ok(!outcome.error.includes("example.invalid"));
  }
});

it("refuses filtered advisories whether pnpm exits with 0 or 1", () => {
  const filtered = { ...findings, advisories: {} };
  assert.equal(read({ ...filtered, ...legacy }, 1).evidenceStatus, "partial");
  assert.equal(read(filtered).evidenceStatus, "partial");
});

it("accepts an informational advisory when the bulk report includes it", () => {
  const report = {
    advisories: { 123: { ...row, severity: "info" } },
    metadata: { ...metadata, vulnerabilities: { ...counts, info: 1 } },
  };
  assert.deepEqual(read(report, 1), {
    advisories: [{ ...advisory, severity: "info" }],
    evidenceStatus: "complete",
  });
});

it("requires the full report envelope and per-severity counts", () => {
  const broken = [
    { metadata },
    { advisories: {} },
    { ...clean, actions: [] },
    { ...clean, ...legacy, muted: [123] },
    { ...clean, advisories: [] },
    { ...clean, metadata: { ...metadata, vulnerabilities: { ...counts, high: "0" } } },
    { ...clean, metadata: { ...metadata, vulnerabilities: { ...counts, total: 1 } } },
  ];
  for (const report of broken) assert.equal(read(report).evidenceStatus, "partial");
});

it("matches exact inventory when supplied and accepts overlap between dev and optional counts", () => {
  const overlap = { ...clean, metadata: { ...metadata, totalDependencies: 2 } };
  assert.equal(read(overlap, 0, 2).evidenceStatus, "complete-empty");
  assert.equal(read(overlap, 0, 3).evidenceStatus, "partial");
  assert.equal(read(clean, 0, 2).evidenceStatus, "partial");
  for (const totalDependencies of [-1, 1, 4, 4.5]) {
    const report = { ...clean, metadata: { ...metadata, totalDependencies } };
    assert.equal(read(report).evidenceStatus, "partial");
  }
  const empty = {
    ...clean,
    metadata: {
      ...metadata,
      dependencies: 0,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 0,
    },
  };
  assert.equal(read(empty, 0, 0).evidenceStatus, "complete-empty");
  assert.equal(read(empty, 0, 3).evidenceStatus, "partial");
});

it("keeps corroborated GHSA findings when sibling entries or counts are broken", () => {
  const report = {
    ...findings,
    advisories: {
      123: { ...row, findings: [{ ...row.findings[0], paths: [".>is-number", null] }] },
      124: {
        ...row,
        id: 124,
        github_advisory_id: "",
        url: "https://example.invalid/GHSA-5555-6666-7777",
      },
      125: { ...row, id: 126 },
    },
  };
  for (const outcome of [
    read(report, 1),
    read({ ...findings, metadata }, 1),
    read(findings, 1, 4),
  ]) {
    assert.equal(outcome.evidenceStatus, "partial");
    assert.ok(outcome.error);
    assert.deepEqual(outcome.advisories, [advisory]);
  }
});

it("accepts a canonical GHSA URL and rejects conflicting IDs or advisories with no paths", () => {
  const withRow = (entry: unknown) => read({ ...findings, advisories: { 123: entry } }, 1);
  assert.deepEqual(withRow({ ...row, github_advisory_id: "" }).advisories, [advisory]);
  for (const entry of [
    { ...row, url: "https://github.com/advisories/GHSA-5555-6666-7777" },
    { ...row, findings: [] },
    { ...row, module_name: "invalid package" },
  ]) {
    const result = withRow(entry);
    assert.equal(result.evidenceStatus, "partial");
    assert.deepEqual(result.advisories, []);
  }
});

it("checks advisory rows before deduplicating GHSAs for the baseline", () => {
  const report = {
    advisories: { 123: { ...row, severity: "low" }, 124: { ...row, id: 124 } },
    metadata: { ...metadata, vulnerabilities: { ...counts, low: 1, high: 1 } },
  };
  assert.deepEqual(read(report, 1), { advisories: [advisory], evidenceStatus: "complete" });
});

it("checks exit codes and retains findings from an interrupted or failed run", () => {
  assert.equal(read(clean, 1).evidenceStatus, "unavailable");
  assert.equal(read(clean, null).evidenceStatus, "unavailable");
  for (const exitCode of [0, 2, null]) {
    const result = read(findings, exitCode);
    assert.equal(result.evidenceStatus, "partial");
    assert.deepEqual(result.advisories, [advisory]);
  }
  const stdout = JSON.stringify(findings);
  const interrupted = readPnpmAuditEvidence({
    stdout,
    stderr: "",
    exitCode: 1,
    error: "timed out",
  });
  const diagnosed = readPnpmAuditEvidence({
    stdout,
    stderr: " ERROR  Unknown option",
    exitCode: 1,
  });
  const envelope = read({ ...findings, error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE" } }, 1);
  for (const outcome of [interrupted, diagnosed, envelope]) {
    assert.equal(outcome.evidenceStatus, "partial");
    assert.deepEqual(outcome.advisories, [advisory]);
  }
});
