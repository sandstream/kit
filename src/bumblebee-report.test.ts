import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { runScan } from "./bumblebee.js";
import { parseScanOutput } from "./bumblebee-report.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const schema = { schema_version: "0.1.0", scanner_name: "bumblebee", run_id: "fixture" };
const summary = {
  ...schema,
  record_type: "scan_summary",
  profile: "project",
  status: "complete",
  timed_out: false,
  package_records_emitted: 0,
  package_records_suppressed: 2,
  findings_emitted: 0,
  files_considered: 1,
};
const finding = {
  ...schema,
  record_type: "finding",
  finding_type: "package_exposure",
  catalog_id: "test-catalog",
  severity: "high",
  ecosystem: "npm",
  normalized_name: "test-package",
  version: "1.0.0",
  source_file: "package-lock.json",
};

function ndjson(...records: object[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

it("reports covered packages and keeps a proven empty project distinct from no coverage", () => {
  const complete = parseScanOutput(ndjson(summary));
  assert.equal(complete.gap, undefined);
  assert.equal(complete.packagesScanned, 2);
  const empty = { ...summary, package_records_suppressed: 0 };
  assert.equal(parseScanOutput(ndjson(empty)).gap, undefined);
  const noTargets = { ...empty, files_considered: 0 };
  assert.equal(parseScanOutput(ndjson(noTargets)).gap?.status, "missing");
});

it("keeps valid findings from a report with bad records", () => {
  const mixed = "\ninvalid line\n" + ndjson(finding, { ...summary, findings_emitted: 1 });
  const parsed = parseScanOutput(mixed);
  assert.equal(parsed.gap?.status, "partial");
  assert.deepEqual(
    parsed.findings.map((entry) => entry.packageName),
    ["test-package"],
  );
  const absent = parseScanOutput(ndjson(finding));
  assert.equal(absent.gap?.status, "partial");
  assert.equal(absent.findings.length, 1);
});

it("distinguishes missing, malformed and unsupported reports", () => {
  assert.equal(parseScanOutput("").gap?.status, "missing");
  assert.equal(parseScanOutput("null").gap?.status, "malformed");
  assert.equal(
    parseScanOutput(ndjson({ ...summary, files_considered: -1 })).gap?.status,
    "malformed",
  );
  assert.equal(
    parseScanOutput(ndjson({ ...summary, schema_version: "1.0.0" })).gap?.status,
    "unsupported",
  );
});

it("requires one matching complete summary and the reported records", () => {
  for (const raw of [
    ndjson(summary, summary),
    ndjson({ ...summary, status: "partial" }),
    ndjson({ ...summary, timed_out: true }),
    ndjson({ ...summary, findings_emitted: 1 }),
    ndjson({ ...summary, package_records_emitted: 1 }),
    ndjson(finding, { ...summary, run_id: "another", findings_emitted: 1 }),
  ])
    assert.equal(parseScanOutput(raw).gap?.status, "partial", raw);
});

it("preserves findings when the child exits nonzero and verifies its reported scope", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "kit-bumblebee-runner-"));
  t.after(() => rmTemp(root));
  const request = {
    install: { binPath: process.execPath, catalogDir: root },
    profile: "project",
    roots: ["."],
    cwd: root,
    timeoutMs: 2_000,
  };
  const scoped = { ...summary, roots: [{ path: root }] };
  function stub(report: string, exitCode: number): void {
    writeFileSync(
      join(root, "scan"),
      `process.stdout.write(${JSON.stringify(report)});process.exitCode=${exitCode};`,
    );
  }
  stub(ndjson(scoped), 0);
  assert.equal((await runScan(request)).gap?.status, "missing");
  writeFileSync(join(root, "catalog.json"), "{}");
  assert.equal((await runScan(request)).gap, undefined);
  stub(ndjson(summary), 0);
  assert.match((await runScan(request)).gap?.reason ?? "", /omitted a requested root/);
  stub(ndjson({ ...scoped, profile: "baseline" }), 0);
  assert.match((await runScan(request)).gap?.reason ?? "", /different profile/);
  stub(ndjson(scoped), 7);
  assert.deepEqual((await runScan(request)).gap, {
    status: "unavailable",
    reason: "scanner failed with exit code 7",
  });
  stub(ndjson(finding, { ...scoped, findings_emitted: 1 }), 7);
  const withFinding = await runScan(request);
  assert.equal(withFinding.gap?.status, "partial");
  assert.equal(withFinding.findings.length, 1);
});
