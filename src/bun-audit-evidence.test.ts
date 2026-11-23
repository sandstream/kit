import assert from "node:assert/strict";
import { it } from "node:test";
import { readBunAuditEvidence } from "./bun-audit-evidence.js";

const packages = new Set(["example", "other"]);
const advisory = {
  id: 42,
  title: "Fixture",
  url: "https://github.com/advisories/GHSA-2222-3333-4444",
  severity: "high",
  vulnerable_versions: "<2.0.0",
};
const report = JSON.stringify({ example: [advisory] });

it("accepts an empty registry map only for a verified successful Bun audit", () => {
  const evidence = { stdout: "{}\n", stderr: "bun audit v1.3.10 (30e609e0)\n", exitCode: 0 };
  assert.equal(readBunAuditEvidence(evidence, packages).evidenceStatus, "complete-empty");
  assert.equal(readBunAuditEvidence(evidence).evidenceStatus, "unsupported");
  assert.ok(readBunAuditEvidence({ ...evidence, exitCode: 1 }, packages).error);
});

it("retains the known advisory after an interrupted or incomplete Bun audit", () => {
  const evidence = { stdout: report, stderr: "", exitCode: 1 };
  assert.equal(readBunAuditEvidence(evidence, packages).evidenceStatus, "complete");
  for (const incomplete of [
    { ...evidence, error: "timeout" },
    { ...evidence, stderr: "warning: registry did not support audits" },
    { ...evidence, stdout: JSON.stringify({ example: [advisory, null] }) },
  ]) {
    const checked = readBunAuditEvidence(incomplete, packages);
    assert.equal(checked.evidenceStatus, "partial");
    assert.deepEqual(
      checked.advisories.map((row) => row.id),
      ["GHSA-2222-3333-4444"],
    );
  }
});

it("refuses unknown report keys, out-of-scope packages and unknown severities", () => {
  for (const stdout of [
    '{"message":"audit report missing"}',
    JSON.stringify({ extra: [advisory] }),
    JSON.stringify({ example: [{ ...advisory, severity: "urgent" }] }),
  ]) {
    const checked = readBunAuditEvidence({ stdout, stderr: "", exitCode: 0 }, packages);
    assert.equal(checked.evidenceStatus, "malformed");
    assert.ok(checked.error);
  }
});
