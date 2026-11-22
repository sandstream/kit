import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runCli } from "../cli-run.test-support.js";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { EMPTY_SARIF, makeFixture, scan, toml, tool, type Fixture } from "./scan.test-support.js";

const skip = process.platform === "win32" ? "fake tools are POSIX shell scripts" : false;
let f: Fixture;
function useFixture(): void {
  beforeEach(() => {
    f = makeFixture();
  });
  afterEach(async () => {
    await rmTemp(f.dir);
  });
}

describe("kit scan: report coverage", { skip }, () => {
  useFixture();

  it("fails a required scan that stopped and keeps its known findings", async () => {
    toml(f, '[scan]\ndelegates = ["grype"]\n[governance.scan]\nrequired_scanners = ["grype"]\n');
    const report = JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "grype" } },
          invocations: [{ executionSuccessful: false }],
          results: [{ ruleId: "sample", level: "warning", message: { text: "Example finding" } }],
        },
      ],
    });
    tool(f, "grype", "printf '%s\\n' '" + report + "'");
    const result = await scan(f, ["--json"], { KIT_EXPLOIT_INTEL: "0" });
    const verdict = JSON.parse(result.stdout);
    assert.equal(result.exitCode, 1, result.stdout + result.stderr);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.coverage, "partial");
    assert.equal(verdict.runs[0].status, "partial");
    assert.equal(verdict.findings.length, 1);
    assert.match(verdict.findings[0].detail, /Example finding/);
    assert.match(verdict.scannerGate.failures[0], /required scanner grype.*partial/);
  });
});

describe("kit scan: missing evidence and SARIF export", { skip }, () => {
  useFixture();

  it("distinguishes missing output and a supported empty scan", async () => {
    toml(f, '[scan]\ndelegates = ["grype"]\n');
    tool(f, "grype", "exit 0");
    const env = { KIT_EXPLOIT_INTEL: "0" };
    const missing = await scan(f, ["--strict", "--json"], env);
    assert.equal(missing.exitCode, 1, missing.stdout);
    assert.equal(JSON.parse(missing.stdout).runs[0].reportGap, "missing");
    const ordinary = await scan(f, [], env);
    assert.equal(ordinary.exitCode, 0, ordinary.stdout);
    assert.match(ordinary.stdout, /No scanner completed/);
    assert.doesNotMatch(ordinary.stdout, /no findings/i);

    tool(f, "grype", "printf '%s\\n' '" + EMPTY_SARIF + "'");
    const empty = await scan(f, ["--strict"], env);
    assert.equal(empty.exitCode, 0, empty.stdout + empty.stderr);
    assert.match(empty.stdout, /no findings from the scanners that ran/);
  });

  it("fails strict mode when there are no scans to verify", async () => {
    toml(f, '[scan]\ndelegates = ["trivy-config"]\n');
    const result = await scan(f, ["--strict", "--json"], { KIT_EXPLOIT_INTEL: "0" });
    assert.equal(result.exitCode, 1, result.stdout);
    const verdict = JSON.parse(result.stdout);
    assert.equal(verdict.coverage, "partial");
    assert.match(verdict.scannerGate.failures[0], /No scanner completed/);
  });

  it("writes only a SARIF document to stdout in air-gap mode", async () => {
    toml(f, '[scan]\ndelegates = ["grype"]\n');
    tool(f, "grype", "printf '%s\\n' '" + EMPTY_SARIF + "'");
    const result = await scan(f, ["--sarif"], { KIT_AIRGAP: "1", KIT_EXPLOIT_INTEL: "0" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runs[0].invocations[0].executionSuccessful, true);
    assert.match(result.stderr, /air-gap mode/);
  });

  it("exports missing coverage even when optional scanners allow exit zero", async () => {
    toml(f, '[scan]\ndelegates = ["grype"]\n');
    const result = await scan(f, ["--sarif"], { KIT_EXPLOIT_INTEL: "0" });
    assert.equal(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.runs[0].invocations[0].executionSuccessful, false);
    const saved = join(f.dir, "report.sarif");
    writeFileSync(saved, result.stdout);
    const imported = await runCli(["ingest", "sarif", saved, "--json"], f.dir);
    assert.equal(imported.exitCode, 1, imported.stdout);
    const evidence = JSON.parse(imported.stdout);
    assert.equal(evidence.reportGap, "partial");
    assert.deepEqual(evidence.scannerCoverage, [
      { id: "grype", status: "not-installed", findings: 0 },
    ]);
  });
});

describe("kit scan: baseline evidence", { skip }, () => {
  useFixture();

  it("keeps the existing baseline when a required scan supplies no report", async () => {
    toml(
      f,
      '[scan]\ndelegates = ["grype", "socket"]\n[governance.scan]\nrequired_scanners = ["grype"]\n',
    );
    tool(f, "socket", "exit 0");
    tool(f, "grype", "exit 0");
    const baseline = join(f.dir, ".kit-baseline.json");
    const original = JSON.stringify({ scan: { findings: ["kept"] } }) + "\n";
    writeFileSync(baseline, original);
    const result = await scan(f, ["--update-baseline"], {
      KIT_EXPLOIT_INTEL: "0",
      SOCKET_SECURITY_API_TOKEN: "fixture-token",
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /coverage cannot support a baseline update/i);
    assert.equal(readFileSync(baseline, "utf8"), original);
  });
});
