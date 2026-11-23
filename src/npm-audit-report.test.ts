import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { runAudit } from "./advisory-baseline.js";
import { auditFixture } from "./audit-concurrency.test-support.js";
import { npmAuditGap, readNpmAuditReport } from "./npm-audit-report.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";

const advisory = {
  url: "https://github.com/advisories/GHSA-2222-3333-4444",
  severity: "high",
  title: "Example",
};
const known = { name: "example", severity: "high", via: [advisory] };
const inherited = { name: "wrapper", severity: "high", via: ["example"] };

function doc(vulnerabilities: Record<string, unknown> = {}, high = 0) {
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical: 0, total: high },
      dependencies: { prod: 3, total: 2 },
    },
  };
}

function withExit(exitCode: number): ExecResult {
  return { exitCode, ok: exitCode === 0, stdout: "", stderr: "" };
}

it("accepts explicit empty evidence with a successful audit exit", () => {
  const report = readNpmAuditReport(JSON.stringify(doc()));
  assert.equal(report.count, 0);
  assert.equal(npmAuditGap(report, withExit(0), "high"), undefined);
  assert.equal(npmAuditGap(report, withExit(1), "high")?.status, "unavailable");
});

for (const [text, expected] of [
  ["", "missing"],
  ["[]", "malformed"],
  ['{"message":"audit report missing"}', "malformed"],
  ['{"auditReportVersion":3}', "unsupported"],
  ['{"error":{"code":"E503"}}', "unavailable"],
  [JSON.stringify({ auditReportVersion: 2, metadata: doc().metadata }), "malformed"],
]) {
  it(`rejects incomplete input (${expected}): ${text || "empty"}`, () => {
    const report = readNpmAuditReport(text);
    assert.equal(npmAuditGap(report, withExit(0), "high")?.status, expected);
  });
}

it("accepts direct and inherited findings from a matching findings exit", () => {
  const report = readNpmAuditReport(JSON.stringify(doc({ example: known, wrapper: inherited }, 2)));
  assert.equal(report.count, 2);
  assert.equal(npmAuditGap(report, withExit(1), "high"), undefined);
  assert.equal(npmAuditGap(report, withExit(0), "high")?.status, "partial");
  assert.equal(npmAuditGap(report, withExit(2), "high")?.status, "partial");
});

it("retains known findings when metadata counts or advisory coverage are incomplete", () => {
  const invalid = readNpmAuditReport(JSON.stringify(doc({ example: known, wrapper: {} }, 1)));
  const wrongCount = readNpmAuditReport(JSON.stringify(doc({ example: known }, 0)));
  const dangling = readNpmAuditReport(JSON.stringify(doc({ wrapper: inherited }, 1)));
  const cycle = { name: "wrapper", severity: "high", via: ["wrapper"] };
  const unexplained = readNpmAuditReport(
    JSON.stringify(doc({ example: known, wrapper: cycle }, 2)),
  );
  for (const [report, count] of [
    [invalid, 1],
    [wrongCount, 1],
    [dangling, 1],
    [unexplained, 2],
  ] as const) {
    assert.equal(report.count, count);
    assert.equal(npmAuditGap(report, withExit(1), "info")?.status, "partial");
  }
});

function runBaseline(t: TestContext, value: unknown, exitCode: number) {
  const { project, env } = auditFixture(t);
  writeFileSync(
    join(project, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/example": { version: "1.0.0" },
        "node_modules/wrapper": { version: "1.0.0" },
      },
    }),
  );
  const code = `process.stdout.write(${JSON.stringify(JSON.stringify(value))}); process.exitCode = ${exitCode}`;
  return runAudit(
    project,
    { manager: "npm", command: [process.execPath, "-e", code] },
    180_000,
    env,
  );
}

it("does not treat a malformed success as an empty baseline audit", (t) => {
  const result = runBaseline(t, { message: "audit report missing" }, 0);
  assert.ok(result.error);
  assert.deepEqual(result.advisories, []);
});

it("keeps a readable baseline advisory when another record is incomplete", (t) => {
  const input = doc({ example: known, wrapper: {} }, 2);
  const result = runBaseline(t, input, 1);
  assert.ok(result.error);
  assert.deepEqual(result.advisories, [
    { id: "GHSA-2222-3333-4444", package: "example", severity: "high", title: "Example" },
  ]);
});

it("blocks a baseline update when the report includes findings without a baseline identifier", (t) => {
  const via = [{ ...advisory, url: "https://registry.npmjs.org/advisory/1" }];
  const result = runBaseline(t, doc({ example: { ...known, via } }, 1), 1);
  assert.match(result.error ?? "", /baseline GHSA identifier/);
  assert.deepEqual(result.advisories, []);
});

it("rejects a higher severity whose direct cause only supports a lower one", () => {
  const report = readNpmAuditReport(
    JSON.stringify(
      doc(
        {
          example: { ...known, via: [{ ...advisory, severity: "low" }] },
        },
        1,
      ),
    ),
  );
  assert.equal(report.count, 1);
  assert.equal(npmAuditGap(report, withExit(1), "high")?.status, "partial");
});
