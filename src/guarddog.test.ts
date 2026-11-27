import assert from "node:assert/strict";
import { it } from "node:test";
import { classifyGuardDog, guardDogScope } from "./guarddog.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";

const clean = { issues: 0, errors: {}, results: {} };
const suspected = {
  issues: 1,
  errors: {},
  results: { typosquatting: "Package name is similar to a popular package" },
};

function entry(dependency: string, version: string, result: unknown = clean) {
  return { dependency, version, result };
}

function run(stdout: string, overrides: Partial<ExecResult> = {}): ExecResult {
  return { exitCode: 0, ok: true, stdout, stderr: "", ...overrides };
}

const npm = guardDogScope("npm", '{"dependencies":{"a":"1.0.0"},"devDependencies":{"b":"^2.0.0"}}');
const pypi = guardDogScope("pypi", "My_Package==1.2.0\nother[extra]>=2\n");

it("accepts complete native npm and PyPI reports", () => {
  for (const [scope, entries] of [
    [npm, [entry("a", "1.0.0"), entry("b", "2.1.0", { ...clean, package_version: "2.1.0" })]],
    [pypi, [entry("my-package", "1.2"), entry("other", "2.0")]],
  ] as const) {
    const r = classifyGuardDog(run(JSON.stringify(entries)), scope);
    assert.equal(r.status, "pass");
    assert.equal(r.evidenceStatus, "complete-empty");
    assert.equal(r.didNotRun, undefined);
  }
});

it("accepts the pinned scanner's empty rule values alongside real findings", () => {
  const placeholders = { metadata: null, other: {}, source: [] };
  const empty = [entry("a", "1.0.0", { ...clean, results: placeholders }), entry("b", "2.1.0")];
  assert.equal(classifyGuardDog(run(JSON.stringify(empty)), npm).evidenceStatus, "complete-empty");
  const results = {
    ...placeholders,
    sample: [{ location: "README.md:1", code: "", message: "Example match" }],
  };
  const hit = [entry("a", "1.0.0", { ...clean, issues: 1, results }), entry("b", "2.1.0")];
  const observed = classifyGuardDog(run(JSON.stringify(hit)), npm);
  assert.equal(observed.status, "fail");
  assert.equal(observed.evidenceStatus, "complete");
});

it("separates an empty target from omitted package results and missing stdout", () => {
  for (const empty of [guardDogScope("npm", "{}"), guardDogScope("pypi", "# comment\n\n")]) {
    const r = classifyGuardDog(run("[]"), empty);
    assert.equal(r.status, "pass");
    assert.equal(r.evidenceStatus, "complete-empty");
    assert.equal(classifyGuardDog(run(""), empty).evidenceStatus, "missing");
  }
  for (const scope of [npm, pypi]) {
    const r = classifyGuardDog(run("[]"), scope);
    assert.equal(r.status, "warn");
    assert.equal(r.evidenceStatus, "missing");
    assert.equal(r.didNotRun, true);
  }
});

it("separates the native missing target diagnostic from a failed process", () => {
  const failed = run("", { ok: false, exitCode: 1 });
  assert.equal(classifyGuardDog(failed, npm).evidenceStatus, "unavailable");
  const missing = classifyGuardDog(
    {
      ...failed,
      stderr:
        "ERROR: Error while scanning. Received unable to find file or directory package.json\n",
    },
    npm,
  );
  assert.equal(missing.evidenceStatus, "missing");
  assert.equal(missing.didNotRun, true);
  assert.equal(
    classifyGuardDog(run("", { didNotStart: true, ok: false }), npm).scanIncomplete,
    undefined,
  );
});

it("uses stdout as the report and rejects malformed or scan-mode shapes", () => {
  const validStderr = JSON.stringify([entry("a", "1.0.0"), entry("b", "2.1.0")]);
  assert.equal(classifyGuardDog(run("", { stderr: validStderr }), npm).evidenceStatus, "missing");
  for (const stdout of [
    "not JSON",
    "null",
    "[null]",
    "{}",
    JSON.stringify({ package: "a", ...clean }),
    JSON.stringify([entry("a", "1.0.0", { issues: 0 })]),
    JSON.stringify([entry("a", "1.0.0", { ...clean, issues: "0" })]),
    JSON.stringify([entry("a", "1.0.0", { ...clean, issues: -1 })]),
    JSON.stringify([entry("a", "1.0.0", { ...clean, errors: [] })]),
    JSON.stringify([entry("a", "1.0.0", { ...clean, results: [] })]),
  ]) {
    const r = classifyGuardDog(run(stdout), npm);
    assert.equal(r.status, "warn", stdout);
    assert.equal(r.evidenceStatus, "malformed", stdout);
    assert.equal(r.didNotRun, true, stdout);
  }
});

it("keeps a valid clean row plus an invalid sibling unverified", () => {
  const r = classifyGuardDog(
    run(JSON.stringify([entry("a", "1.0.0"), entry("b", "2.1.0"), null])),
    npm,
  );
  assert.equal(r.status, "warn");
  assert.equal(r.evidenceStatus, "partial");
});

it("rejects ambiguous npm manifests and report arrays", () => {
  const ambiguous = guardDogScope("npm", '{"dependencies":{"a":"1.0.0"},"dependencies":{}}');
  assert.equal(ambiguous.gap, "malformed");
  const empty = guardDogScope("npm", "{}");
  for (const stdout of [
    '[{"dependency":"a","version":"1.0.0","result":{"issues":1,"issues":0,"errors":{},"results":{}}}]',
    '[], "extra": []',
  ]) {
    assert.equal(classifyGuardDog(run(stdout), empty).evidenceStatus, "malformed");
  }
});

it("requires each declared package and pin even when report counts agree", () => {
  for (const entries of [
    [entry("a", "1.0.0"), entry("a", "1.0.0")],
    [entry("a", "1.0.1"), entry("b", "2.1.0")],
    [entry("a", "1.0.0"), entry("other", "2.1.0")],
    [entry("a", "1.0.0"), entry("b", "2.1.0", { ...clean, package_version: "2.1.1" })],
  ]) {
    assert.equal(classifyGuardDog(run(JSON.stringify(entries)), npm).evidenceStatus, "partial");
  }
  const twoPins = guardDogScope(
    "npm",
    '{"dependencies":{"a":"1.0.0"},"devDependencies":{"a":"2.0.0"}}',
  );
  assert.equal(
    classifyGuardDog(run(JSON.stringify([entry("a", "1.0.0")])), twoPins).status,
    "warn",
  );
  assert.equal(
    classifyGuardDog(run(JSON.stringify([entry("a", "1.0.0"), entry("a", "2.0.0")])), twoPins)
      .status,
    "pass",
  );
});

it("checks aliases by registry name and leaves unsupported selectors unverified", () => {
  const alias = guardDogScope("npm", '{"dependencies":{"alias":"npm:@scope/a@1.0.0"}}');
  assert.equal(
    classifyGuardDog(run(JSON.stringify([entry("@scope/a", "1.0.0")])), alias).status,
    "pass",
  );
  for (const scope of [
    guardDogScope("npm", '{"dependencies":{"a":"file:../a"}}'),
    guardDogScope("pypi", "-r nested.txt\n"),
    guardDogScope("pypi", "  omitted==1.2.0\n"),
    guardDogScope("pypi", "omitted @ https://example.org/a.whl\n"),
  ]) {
    assert.equal(classifyGuardDog(run("[]"), scope).evidenceStatus, "partial");
  }
  const arbitraryPin = guardDogScope("pypi", "example===1.2.0\n");
  assert.equal(
    classifyGuardDog(run(JSON.stringify([entry("example", "1.2")])), arbitraryPin).evidenceStatus,
    "partial",
  );
});

it("flags download errors, skipped dependencies, and interrupted clean reports", () => {
  const rows = JSON.stringify([entry("a", "1.0.0"), entry("b", "2.1.0")]);
  for (const outcome of [
    run(
      JSON.stringify([
        entry("a", "1.0.0"),
        entry("b", "2.1.0", {
          issues: 0,
          errors: { "download-package": "registry unavailable" },
        }),
      ]),
    ),
    run(rows, { stderr: "ERROR: Package/Version b not on NPM\n" }),
    run(rows, { stderr: "WARNING: Received keyboard interrupt, cancelling scan\n" }),
    run(rows, { exitCode: 1, ok: false, timedOut: true }),
    run(rows, { exitCode: 1, ok: false, truncated: true }),
  ]) {
    const r = classifyGuardDog(outcome, npm);
    assert.equal(r.status, "warn");
    assert.equal(r.evidenceStatus, "partial");
    assert.equal(r.scanIncomplete, true);
  }
  const failed = classifyGuardDog(run(rows, { exitCode: 1, ok: false }), npm);
  assert.equal(failed.status, "warn");
  assert.equal(failed.evidenceStatus, "unavailable");
  assert.equal(classifyGuardDog(run(rows), npm, true).evidenceStatus, "partial");
});

it("retains real findings on complete, malformed-sibling, failed, and partial scans", () => {
  const pyEntries = JSON.stringify([entry("my-package", "1.2", suspected), entry("other", "2.0")]);
  const complete = classifyGuardDog(run(pyEntries), pypi);
  assert.equal(complete.status, "fail");
  assert.equal(complete.evidenceStatus, "complete");
  assert.equal(complete.hasFindings, true);
  assert.match(complete.detail, /guarddog pypi verify/);
  for (const result of [
    run(JSON.stringify([entry("a", "1.0.0", suspected), null])),
    run(
      JSON.stringify([
        entry("a", "1.0.0", { ...suspected, errors: { "rules-all": "could not run" } }),
      ]),
    ),
    run(JSON.stringify([entry("a", "1.0.0", { ...suspected, issues: 0 })])),
    run(pyEntries, { exitCode: 1, ok: false }),
  ]) {
    const scope = result.stdout === pyEntries ? pypi : npm;
    const r = classifyGuardDog(result, scope);
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
    assert.equal(r.hasFindings, true);
    assert.equal(r.didNotRun, true);
    assert.equal(r.evidenceStatus, "partial");
  }
});

it("counts threat and metadata findings, not GuardDog 3 capability inventory", () => {
  const hit = (location: string) => [{ location, code: "", message: "Example match" }];
  const inventory = {
    "capability-network-outbound": hit("package/a.js:1"),
    "capability-process-spawn": hit("package/b.js:2"),
    "threat-network-exfiltration": {},
  };
  const inventoryResult = { ...clean, issues: 2, results: inventory };
  const capabilityOnly = entry("a", "1.0.0", inventoryResult);
  const quiet = classifyGuardDog(run(JSON.stringify([capabilityOnly, entry("b", "2.1.0")])), npm);
  assert.equal(quiet.status, "pass");
  assert.equal(quiet.evidenceStatus, "complete-empty");

  const threats = {
    ...inventory,
    "threat-runtime-obfuscation": hit("package/c.js:3"),
    typosquatting: "Package name is similar to a popular package",
  };
  const mixed = entry("a", "1.0.0", { ...clean, issues: 4, results: threats });
  const found = classifyGuardDog(run(JSON.stringify([mixed, entry("b", "2.1.0")])), npm);
  assert.equal(found.status, "fail");
  assert.equal(found.evidenceStatus, "complete");
  assert.match(found.detail, /^2 malware indicator\(s\)/);

  // A rule error still leaves coverage unverified; capability inventory does not turn it into a hit.
  const errored = { ...inventoryResult, errors: { metadata_mismatch: "failed to run rule" } };
  const partial = classifyGuardDog(
    run(JSON.stringify([entry("a", "1.0.0", errored), entry("b", "2.1.0")])),
    npm,
  );
  assert.equal(partial.status, "warn");
  assert.equal(partial.evidenceStatus, "partial");
  assert.equal(partial.scanIncomplete, true);
  // Results kit cannot read keep GuardDog's own count.
  const unreadable = entry("a", "1.0.0", { issues: 2, errors: {}, results: { x: 5 } });
  const kept = classifyGuardDog(run(JSON.stringify([unreadable, entry("b", "2.1.0")])), npm);
  assert.match(kept.detail, /^2 malware indicator\(s\)/);
});
