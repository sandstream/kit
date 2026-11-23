import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runCli } from "../cli-run.test-support.js";
import { rmTemp } from "../temp-cleanup.test-support.js";
import {
  EMPTY_SARIF,
  makeFixture,
  scan,
  SOCKET_PASS,
  socketReport,
  toml,
  tool,
  type Fixture,
} from "./scan.test-support.js";

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

  it("keeps the baseline when OSV returns an unidentified package with no findings", async () => {
    toml(f, '[scan]\ndelegates = ["osv-scanner"]\n');
    tool(f, "osv-scanner", `echo '{"results":[{"packages":[{}]}]}'`);
    const baseline = join(f.dir, ".kit-baseline.json");
    const original = JSON.stringify({
      version: 1,
      generated: new Date(0).toISOString(),
      categories: { scan: { findings: ["kept"] } },
    });
    writeFileSync(baseline, original);
    const env = { KIT_EXPLOIT_INTEL: "0" };
    const result = await scan(f, ["--strict", "--json"], env);
    assert.equal(result.exitCode, 1, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).runs[0].reportGap, "malformed");
    assert.equal((await scan(f, ["--update-baseline"], env)).exitCode, 1);
    assert.equal(readFileSync(baseline, "utf8"), original);
  });

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
    tool(f, "socket", SOCKET_PASS);
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

describe("kit scan: Socket policy coverage", { skip }, () => {
  useFixture();

  it("does not let exit 0 alone support strict scan coverage", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    tool(f, "socket", "exit 0");
    const r = await scan(f, ["--strict", "--json"], { SOCKET_SECURITY_API_TOKEN: "fixture" });
    assert.equal(r.exitCode, 1, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.coverage, "partial");
    assert.equal(report.runs[0].reportGap, "missing");
  });

  it("requires a full Socket CI report for strict coverage", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    tool(f, "socket", `echo '{"ok":true,"data":{"healthy":true}}'; exit 0`);
    const r = await scan(f, ["--strict", "--json"], { SOCKET_SECURITY_API_TOKEN: "fixture" });
    assert.equal(r.exitCode, 1, r.stdout);
    const report = JSON.parse(r.stdout);
    assert.equal(report.coverage, "partial");
    assert.equal(report.runs[0].status, "error");
  });

  it("keeps a contradictory Socket policy finding with partial coverage", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    const native = socketReport(false);
    const contradictory = { ...native, data: { ...native.data, healthy: true } };
    tool(f, "socket", `echo '${JSON.stringify(contradictory)}'; exit 0`);
    const r = await scan(f, ["--strict", "--json"], { SOCKET_SECURITY_API_TOKEN: "fixture" });
    assert.equal(r.exitCode, 1, r.stdout);
    const report = JSON.parse(r.stdout);
    assert.equal(report.coverage, "partial");
    assert.equal(report.runs[0].reportGap, "partial");
    assert.equal(report.findings[0].severity, "high");
    assert.match(report.findings[0].detail, /policy violation/);
  });

  it("distinguishes missing Socket policy reports from malformed evidence", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    const env = { SOCKET_SECURITY_API_TOKEN: "fixture" };
    const cases = [
      [{ ok: false, message: "Socket API error", data: { code: 403 } }, "missing"],
      [{ ok: false, message: "Input error" }, "missing"],
      [{ ok: false, message: "Invalid Socket API response" }, "malformed"],
      [{ ok: false, message: 1 }, "malformed"],
    ] as const;
    for (const [response, gap] of cases) {
      tool(f, "socket", `echo '${JSON.stringify(response)}'; exit 1`);
      const result = await scan(f, ["--strict", "--json"], env);
      assert.equal(result.exitCode, 1, result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.coverage, "partial");
      assert.equal(report.runs[0].reportGap, gap, JSON.stringify(response));
      assert.equal(report.findings[0].didNotRun, true);
    }
  });

  it("does not admit a failed Socket invocation into the baseline", async () => {
    toml(f, '[scan]\ndelegates = ["socket"]\n');
    tool(f, "socket", `echo '{"ok":false,"message":"no manifests"}'; exit 1`);
    const baseline = join(f.dir, ".kit-baseline.json");
    const original = JSON.stringify({
      version: 1,
      generated: new Date(0).toISOString(),
      categories: { scan: { findings: ["kept"] } },
    });
    writeFileSync(baseline, original);
    const env = { SOCKET_SECURITY_API_TOKEN: "fixture" };
    const scanned = await scan(f, ["--json"], env);
    assert.equal(scanned.exitCode, 1, scanned.stdout + scanned.stderr);
    const report = JSON.parse(scanned.stdout);
    assert.equal(report.runs[0].status, "error");
    assert.equal(report.findings[0].didNotRun, true);
    assert.equal((await scan(f, ["--update-baseline"], env)).exitCode, 1);
    assert.equal(readFileSync(baseline, "utf8"), original);
  });
});
