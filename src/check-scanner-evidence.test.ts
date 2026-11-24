import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { runCli } from "./cli-run.test-support.js";
import { makeFixture, toml, tool } from "./commands/scan.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const posix = { skip: process.platform === "win32" ? "scanner fixtures use POSIX shell" : false };

const osvName = "osv-scanner (deps)";
const trivyFsName = "trivy container scan";
const trivyConfigName = "trivy config (IaC)";
const trivyJvmName = "trivy fs (gradle)";

interface Reply {
  report: unknown;
  exit?: number;
  interrupted?: true;
}

interface CheckRow {
  name: string;
  status: string;
  didNotRun?: true;
  scanIncomplete?: true;
  hasFindings?: true;
  evidenceStatus?: string;
  detail: string;
}

function reply({ report, exit = 0, interrupted }: Reply): string {
  const end = interrupted ? 'kill -TERM "$$"' : "exit " + exit;
  return "printf '%s\\n' '" + JSON.stringify(report).replaceAll("'", "'\\''") + "'\n" + end;
}

async function inspect(
  t: TestContext,
  osv: Reply,
  fs: Reply,
  config = fs,
  options: { compose?: true; mode?: "default" | "lenient" } = {},
) {
  const fixture = makeFixture();
  t.after(() => rmTemp(fixture.dir));
  toml(fixture, "version = 1\n[memory]\ntrack_findings = false\n");
  writeFileSync(join(fixture.dir, "Dockerfile"), "FROM scratch\nUSER 65532\n");
  if (options.compose)
    writeFileSync(join(fixture.dir, "compose.yaml"), "services:\n  fixture:\n    image: scratch\n");
  writeFileSync(join(fixture.dir, "go.mod"), "module example.test/kit-proof\n\ngo 1.24\n");
  writeFileSync(join(fixture.dir, "build.gradle"), "");
  writeFileSync(join(fixture.dir, "gradle.lockfile"), "# fixture\n");
  tool(fixture, "osv-scanner", reply(osv));
  tool(
    fixture,
    "trivy",
    'case "$1" in config)\n' + reply(config) + "\n;;\n*)\n" + reply(fs) + "\n;;\nesac",
  );
  const flags =
    options.mode === "default" ? [] : [options.mode === "lenient" ? "--lenient" : "--strict"];
  const run = await runCli(["check", "--category", "security", "--json", ...flags], fixture.dir, {
    PATH: fixture.bin,
    KIT_AIRGAP: "0",
    KIT_NO_UPDATE_CHECK: "1",
    KIT_AUDIT_ANCHOR: "0",
    KIT_ADVISORIES: "0",
    KIT_BUMBLEBEE: "0",
    KIT_SEMGREP_CONFIG: "",
  });
  assert.ok(run.stdout.startsWith("{"), run.stdout + run.stderr);
  const out = JSON.parse(run.stdout) as { checks: CheckRow[] };
  return {
    exitCode: run.exitCode,
    rows: out.checks,
    row(name: string) {
      const row = out.checks.find((candidate) => candidate.name === name);
      assert.ok(row, "missing check row: " + name);
      return row;
    },
  };
}

const emptyOsv = { results: [] };
const trivy = {
  SchemaVersion: 2,
  ArtifactName: ".",
  ArtifactType: "filesystem",
};
const emptyFs = {
  ...trivy,
  Results: [{ Target: "gradle.lockfile", Class: "lang-pkgs", Type: "gradle" }],
};
const emptyIac = {
  ...trivy,
  Results: [{ Target: "Dockerfile", Class: "config", Type: "dockerfile" }],
};

it(
  "refuses to verify malformed scanner envelopes after an exit status of zero",
  posix,
  async (t) => {
    const malformed = { report: {} };
    const result = await inspect(t, malformed, malformed);
    assert.equal(result.exitCode, 1);
    for (const name of [osvName, trivyFsName, trivyConfigName, trivyJvmName]) {
      const row = result.row(name);
      assert.equal(row.status, "warn", JSON.stringify(row));
      assert.equal(row.didNotRun, true, JSON.stringify(row));
      assert.equal(row.evidenceStatus, "malformed");
    }
  },
);

it("refuses to verify valid-looking empty reports from failed scanners", posix, async (t) => {
  const result = await inspect(
    t,
    { report: emptyOsv, exit: 127 },
    { report: emptyFs, exit: 2 },
    { report: emptyIac, exit: 2 },
  );
  assert.equal(result.exitCode, 1);
  for (const name of [osvName, trivyFsName, trivyConfigName, trivyJvmName]) {
    const row = result.row(name);
    assert.equal(row.status, "warn", JSON.stringify(row));
    assert.equal(row.didNotRun, true, JSON.stringify(row));
    assert.equal(row.evidenceStatus, "unavailable");
  }
});

it("accepts separately covered empty reports from successful scanners", posix, async (t) => {
  const result = await inspect(t, { report: emptyOsv }, { report: emptyFs }, { report: emptyIac });
  for (const name of [osvName, trivyFsName, trivyConfigName, trivyJvmName]) {
    const row = result.row(name);
    assert.equal(row.status, "pass", JSON.stringify(row));
    assert.equal(row.didNotRun, undefined);
    assert.equal(row.evidenceStatus, "complete-empty");
  }
});

it("keeps findings when a scanner returns a damaged or interrupted report", posix, async (t) => {
  const result = await inspect(
    t,
    {
      report: {
        results: [
          {
            packages: [
              {
                package: { name: "proof-package", ecosystem: "npm", version: "1.0.0" },
                vulnerabilities: [{ id: "test-advisory" }, null],
              },
            ],
          },
        ],
      },
      exit: 1,
    },
    {
      report: {
        ...emptyFs,
        Results: [
          {
            ...emptyFs.Results[0],
            Vulnerabilities: [{ VulnerabilityID: "CVE-2026-12345", Severity: "HIGH" }],
          },
        ],
      },
      exit: 2,
    },
    { report: trivy },
  );
  for (const name of [osvName, trivyFsName, trivyJvmName]) {
    const row = result.row(name);
    assert.equal(row.hasFindings, true);
    assert.equal(row.didNotRun, true);
    assert.equal(row.evidenceStatus, "partial");
    assert.match(row.detail, /1 .*vulnerabilit|1 .*CVE/);
  }
  assert.equal(result.row(trivyConfigName).evidenceStatus, "missing");
  assert.equal(result.row(trivyConfigName).didNotRun, true);
});

it(
  "keeps absent OSV targets and unrelated Trivy targets separate from clean scans",
  posix,
  async (t) => {
    const npmOnly = {
      ...trivy,
      Results: [{ Target: "package-lock.json", Class: "lang-pkgs", Type: "npm" }],
    };
    const result = await inspect(
      t,
      { report: emptyOsv, exit: 128 },
      { report: npmOnly },
      { report: emptyIac },
    );
    assert.equal(result.row(osvName).evidenceStatus, "missing");
    assert.equal(result.row(osvName).didNotRun, true);
    assert.equal(result.row(trivyJvmName).evidenceStatus, "missing");
    assert.equal(result.row(trivyJvmName).didNotRun, true);
    assert.equal(result.row(trivyFsName).evidenceStatus, "complete-empty");
  },
);

it(
  "rejects a stopped scanner which printed an empty report before interruption",
  posix,
  async (t) => {
    const result = await inspect(
      t,
      { report: emptyOsv, interrupted: true },
      { report: emptyFs, interrupted: true },
      { report: emptyIac },
    );
    for (const name of [osvName, trivyFsName, trivyJvmName]) {
      const row = result.row(name);
      assert.equal(row.evidenceStatus, "unavailable");
      assert.equal(row.didNotRun, true);
      assert.match(row.detail, /without an exit status/);
    }
    assert.equal(result.row(trivyConfigName).evidenceStatus, "complete-empty");
  },
);

it(
  "keeps default scanner health red when Trivy omits a discovered Compose file",
  posix,
  async (t) => {
    const osv = { report: emptyOsv };
    const fs = { report: emptyFs };
    const config = { report: emptyIac };
    const normal = await inspect(t, osv, fs, config, { compose: true, mode: "default" });
    const partial = normal.row(trivyConfigName);
    assert.equal(partial.status, "warn");
    assert.equal(partial.didNotRun, true);
    assert.equal(partial.evidenceStatus, "partial");
    assert.match(partial.detail, /reported 1 of 2 expected/);
    assert.equal(normal.exitCode, 1, JSON.stringify(normal.rows.filter((r) => r.didNotRun)));
    const lenient = await inspect(t, osv, fs, config, { compose: true, mode: "lenient" });
    assert.equal(lenient.row(trivyConfigName).evidenceStatus, "partial");
    assert.equal(
      lenient.exitCode,
      0,
      JSON.stringify(lenient.rows.filter((r) => r.status === "fail")),
    );
  },
);
