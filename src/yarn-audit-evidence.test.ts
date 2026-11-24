import assert from "node:assert/strict";
import { it } from "node:test";
import { readYarnAuditEvidence } from "./yarn-audit-evidence.js";

// Captured from Yarn 4.17.0 against the default registry with a scratch lockfile and no install.
const nativeHigh = {
  value: "lodash",
  children: {
    ID: 1106913,
    Issue: "Command Injection in lodash",
    URL: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm",
    Severity: "high",
    "Vulnerable Versions": "<4.17.21",
    "Tree Versions": ["4.17.20"],
    Dependents: ["kit-yarn-audit-fixture@workspace:."],
  },
};
const nativeModerate = {
  value: "lodash",
  children: {
    ID: 1108258,
    Issue: "Regular Expression Denial of Service (ReDoS) in lodash",
    URL: "https://github.com/advisories/GHSA-29mw-wpgm-hmr9",
    Severity: "moderate",
    "Vulnerable Versions": ">=4.0.0 <4.17.21",
    "Tree Versions": ["4.17.20"],
    Dependents: ["kit-yarn-audit-fixture@workspace:."],
  },
};
const highAdvisory = {
  id: "GHSA-35JH-R3H4-6JHM",
  package: "lodash",
  severity: "high",
  title: nativeHigh.children.Issue,
};
const moderateAdvisory = {
  id: "GHSA-29MW-WPGM-HMR9",
  package: "lodash",
  severity: "moderate",
  title: nativeModerate.children.Issue,
};
const findings = ndjson(nativeHigh, nativeModerate);

function ndjson(...rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row) + "\n").join("");
}

function audit(
  stdout: string,
  exitCode: number | null,
  extra?: { stderr?: string; error?: string },
) {
  return readYarnAuditEvidence({ stdout, stderr: "", exitCode, ...extra });
}

it("accepts exactly silent successful Yarn 4.17.0 JSON output as complete-empty", () => {
  assert.deepEqual(audit("", 0), { advisories: [], evidenceStatus: "complete-empty" });
  for (const stdout of [" ", "\n", "➤ YN0001: No audit suggestions\n"]) {
    const outcome = audit(stdout, 0);
    assert.equal(outcome.evidenceStatus, "malformed");
    assert.ok(outcome.error);
  }
});

it("reads native advisory NDJSON and sorts by GHSA", () => {
  assert.deepEqual(audit(findings, 1), {
    advisories: [moderateAdvisory, highAdvisory],
    evidenceStatus: "complete",
  });
});

it("treats Yarn registry errors on stdout as unavailable", () => {
  const stdout =
    "➤ YN0080: Request to 'https://registry.yarnpkg.com/-/npm/v1/security/advisories/bulk' has been blocked because of your configuration settings\n\n" +
    "➤ Errors happened when preparing the environment required to run this command.\n" +
    '➤ This might be caused by packages being missing from the lockfile, in which case running "yarn install" might help.\n';
  const outcome = audit(stdout, 1);
  assert.equal(outcome.evidenceStatus, "unavailable");
  assert.deepEqual(outcome.advisories, []);
  assert.ok(outcome.error);
});

it("rejects arbitrary JSON, npm bulk JSON and other report layouts", () => {
  const wrongReports = [
    {},
    [],
    { lodash: [{ id: nativeHigh.children.ID, url: nativeHigh.children.URL }] },
    { type: "info", name: 1, displayName: "YN0001", indent: "", data: "No audit suggestions" },
    { type: "auditAdvisory", data: nativeHigh },
    [nativeHigh],
  ];
  for (const report of wrongReports) {
    const outcome = audit(ndjson(report), 0);
    assert.equal(outcome.evidenceStatus, "malformed");
    assert.deepEqual(outcome.advisories, []);
    assert.ok(outcome.error);
  }
});

it("keeps findings on either side of a malformed or unrecognized row", () => {
  const stdout = ndjson(nativeHigh) + "unexpected line\n" + ndjson({}, nativeModerate);
  const outcome = audit(stdout, 1);
  assert.equal(outcome.evidenceStatus, "partial");
  assert.deepEqual(outcome.advisories, [moderateAdvisory, highAdvisory]);
  assert.ok(outcome.error);
});

it("keeps a finding once if its Yarn tree key repeats and marks the report partial", () => {
  const outcome = audit(ndjson(nativeHigh, nativeHigh), 1);
  assert.equal(outcome.evidenceStatus, "partial");
  assert.deepEqual(outcome.advisories, [highAdvisory]);
  assert.ok(outcome.error);
});

it("retains identifiable findings when the affected tree is missing or invalid", () => {
  for (const versions of [undefined, [], [null], ["invalid"]]) {
    const children = { ...nativeHigh.children, "Tree Versions": versions };
    const outcome = audit(ndjson({ ...nativeHigh, children }), 1);
    assert.equal(outcome.evidenceStatus, "partial");
    assert.deepEqual(outcome.advisories, [highAdvisory]);
    assert.ok(outcome.error);
  }
  const children = { ...nativeHigh.children, Dependents: [], "Tree Versions": [] };
  assert.equal(audit(ndjson({ ...nativeHigh, children }), 1).evidenceStatus, "partial");
});

it("preserves parsed findings but requires newline framing and the native findings exit", () => {
  for (const outcome of [audit(findings, 0), audit(findings.trimEnd(), 1), audit(findings, 2)]) {
    assert.equal(outcome.evidenceStatus, "partial");
    assert.deepEqual(outcome.advisories, [moderateAdvisory, highAdvisory]);
    assert.ok(outcome.error);
  }
});

it("requires an empty stderr and a successful exit for silent output", () => {
  for (const outcome of [
    audit("", 1),
    audit("", 2),
    audit("", null),
    audit("", 0, { error: "spawn failed" }),
    audit("", 0, { stderr: "scanner diagnostic\n" }),
  ]) {
    assert.equal(outcome.evidenceStatus, "unavailable");
    assert.ok(outcome.error);
  }
});

it("keeps findings when there is a process error, missing exit status or stderr output", () => {
  for (const outcome of [
    audit(findings, 1, { error: "timed out" }),
    audit(findings, null),
    audit(findings, 1, { stderr: "scanner diagnostic\n" }),
  ]) {
    assert.equal(outcome.evidenceStatus, "partial");
    assert.deepEqual(outcome.advisories, [moderateAdvisory, highAdvisory]);
    assert.ok(outcome.error);
  }
});

it("does not treat an unidentifiable or conflicting advisory as complete", () => {
  for (const overrides of [
    { URL: "https://example.test/advisories/GHSA-35jh-r3h4-6jhm" },
    { URL: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm-extra" },
    { ID: moderateAdvisory.id },
    { Severity: "medium" },
  ]) {
    const children = { ...nativeHigh.children, ...overrides };
    const outcome = audit(ndjson({ ...nativeHigh, children }, nativeModerate), 1);
    assert.equal(outcome.evidenceStatus, "partial");
    assert.deepEqual(outcome.advisories, [moderateAdvisory]);
    assert.ok(outcome.error);
  }
});

it("accepts a direct GHSA ID in a row without a URL and keeps its highest severity", () => {
  const children = { ...nativeHigh.children, ID: highAdvisory.id, URL: undefined, Severity: "low" };
  const row = { value: "@scope/example", children };
  const outcome = audit(ndjson(row, nativeHigh), 1);
  assert.deepEqual(outcome, { advisories: [highAdvisory], evidenceStatus: "complete" });
  assert.deepEqual(audit(ndjson(row), 1), {
    advisories: [{ ...highAdvisory, package: "@scope/example", severity: "low" }],
    evidenceStatus: "complete",
  });
});
