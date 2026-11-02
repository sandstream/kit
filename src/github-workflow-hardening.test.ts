import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function workflow(name: string): string {
  return readFileSync(resolve(root, ".github/workflows", name), "utf8");
}

function section(text: string, start: string, end: string): string {
  const from = text.indexOf(`\n  ${start}:`);
  const to = text.indexOf(`\n  ${end}:`, from + 1);
  assert.ok(from >= 0 && to > from, `missing ${start} workflow job`);
  return text.slice(from, to);
}

describe("GitHub workflow hardening", () => {
  it("removes implicit token grants before job-specific permissions", () => {
    assert.match(workflow("publish.yml"), /^permissions:\s*\{\}\s*$/m);
    assert.match(workflow("docker-build.yml"), /^permissions:\s*\{\}\s*$/m);
  });

  it("grants security-events write only to SARIF upload jobs", () => {
    const security = workflow("security.yml");
    assert.doesNotMatch(security, /^ {2}security-events:\s*write\s*$/m);

    for (const job of [
      section(security, "container", "infra"),
      section(security, "infra", "secrets"),
    ]) {
      assert.match(job, /\n {4}permissions:\n {6}contents:\s*read\n {6}security-events:\s*write/);
    }
  });

  it("runs CodeQL analysis as a required security job", () => {
    const security = workflow("security.yml");
    const codeql = section(security, "codeql", "dast");
    assert.match(codeql, /github\/codeql-action\/init@[a-f0-9]{40}/);
    assert.match(codeql, /github\/codeql-action\/analyze@[a-f0-9]{40}/);
    assert.match(codeql, /\n {4}permissions:\n {6}contents:\s*read\n {6}security-events:\s*write/);

    const gate = security.slice(security.indexOf("\n  gate:"));
    assert.match(gate, /needs:\s*\[[^\]]*\bcodeql\b[^\]]*\]/);
  });

  it("installs nightly Python scanners at triaged exact versions", () => {
    const security = workflow("security.yml");
    assert.match(security, /python3 -m pip install --user pipx==1\.17\.2/);
    assert.match(security, /pipx install guarddog==3\.2\.0/);
    assert.match(security, /pipx install semgrep==1\.176\.0/);
  });

  it("runs the pinned Semgrep scanner with every required rule pack", () => {
    const sast = section(workflow("security.yml"), "sast", "codeql");
    assert.match(sast, /(?:pipx install|pip install|pip3 install) semgrep==1\.176\.0/);
    assert.doesNotMatch(sast, /semgrep\/semgrep-action@/);
    const scanStep = sast.match(
      /- name: Semgrep \(application code only\)[\s\S]*?(?=\n {6}- name:|$)/,
    )?.[0];
    assert.ok(scanStep, "missing Semgrep scan step");
    assert.match(scanStep, /set -e/);
    assert.match(
      scanStep,
      /for config in p\/security-audit p\/owasp-top-ten p\/typescript p\/nodejs; do/,
    );
    assert.match(scanStep, /python3 scripts\/run-semgrep\.py --config "\$config" \./);
    for (const pack of ["p/security-audit", "p/owasp-top-ten", "p/typescript", "p/nodejs"]) {
      assert.ok(scanStep.includes(pack), `Semgrep scan is missing ${pack}`);
    }
    assert.doesNotMatch(scanStep, /^\s+if:/m);
    assert.doesNotMatch(scanStep, /continue-on-error:\s*true/);
  });

  it("executes all Semgrep packs and stops if any pack fails", (t) => {
    if (process.platform === "win32") {
      t.skip("The Semgrep step runs in a Linux GitHub Actions runner");
      return;
    }
    const sast = section(workflow("security.yml"), "sast", "codeql");
    const scanStep = sast.match(
      /- name: Semgrep \(application code only\)[\s\S]*?(?=\n {6}- name:|$)/,
    )?.[0];
    assert.ok(scanStep, "missing Semgrep scan step");
    const shell = scanStep.match(/\n {8}run: \|\n((?: {10}[^\n]*(?:\n|$))*)/)?.[1];
    assert.ok(shell, "missing Semgrep shell block");

    const packs = ["p/security-audit", "p/owasp-top-ten", "p/typescript", "p/nodejs"];
    const temp = mkdtempSync(join(tmpdir(), "kit-semgrep-workflow-test-"));
    try {
      const calls = join(temp, "calls");
      writeFileSync(
        join(temp, "python3"),
        [
          "#!/bin/sh",
          'if [ "$#" -ne 4 ] || [ "$1" != scripts/run-semgrep.py ] || [ "$2" != --config ] || [ "$4" != . ]; then exit 99; fi',
          'printf "%s\\n" "$3" >> "$SEMGREP_TEST_CALLS"',
          'if [ "$3" = "$SEMGREP_TEST_FAIL_PACK" ]; then exit 42; fi',
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      for (const [index, failedPack] of ["", ...packs].entries()) {
        writeFileSync(calls, "");
        const run: SpawnSyncReturns<string> = spawnSync(
          "bash",
          ["--noprofile", "--norc", "-eo", "pipefail", "-c", shell],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${temp}${delimiter}${process.env.PATH ?? ""}`,
              SEMGREP_TEST_CALLS: calls,
              SEMGREP_TEST_FAIL_PACK: failedPack,
            },
          },
        );
        assert.equal(run.status, failedPack ? 42 : 0, run.stderr);
        const called = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
        assert.deepEqual(called, failedPack ? packs.slice(0, index) : packs);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("requires SAST to succeed before the security gate can pass", () => {
    const security = workflow("security.yml");
    const gate = security.slice(security.indexOf("\n  gate:"));
    assert.match(gate, /needs:\s*\[[^\]]*\bsast\b[^\]]*\]/);
    assert.match(gate, /\n {4}if:\s*always\(\)/);
    assert.match(
      gate,
      /if \[ "\$\{\{ contains\(needs\.\*\.result, 'failure'\) \|\| contains\(needs\.\*\.result, 'cancelled'\) \|\| contains\(needs\.\*\.result, 'skipped'\) \}\}" = "true" \]; then[\s\S]*?exit 1[\s\S]*?fi/,
    );
  });

  it("executes the gate shell for success and each non-success result", (t) => {
    if (process.platform === "win32") {
      t.skip("The security gate runs in a Linux GitHub Actions runner");
      return;
    }
    const security = workflow("security.yml");
    const gate = security.slice(security.indexOf("\n  gate:"));
    const shell = gate.match(/\n {8}run: \|\n((?: {10}[^\n]*(?:\n|$))*)/)?.[1];
    assert.ok(shell, "missing security gate shell");
    const expression =
      /\$\{\{ contains\(needs\.\*\.result, 'failure'\) \|\| contains\(needs\.\*\.result, 'cancelled'\) \|\| contains\(needs\.\*\.result, 'skipped'\) \}\}/;
    assert.match(shell, expression);
    for (const [result, expected] of [
      ["success", 0],
      ["failure", 1],
      ["cancelled", 1],
      ["skipped", 1],
    ] as const) {
      const expanded: string = shell.replace(expression, result === "success" ? "false" : "true");
      const executed = spawnSync("bash", ["-e", "-c", expanded], { encoding: "utf8" });
      assert.equal(
        executed.status,
        expected,
        `gate returned ${executed.status} for ${result}: ${executed.stderr}`,
      );
    }
  });

  it("makes a missing Snyk token visible in the dependency job", () => {
    const deps = section(workflow("security.yml"), "deps", "supply-chain");
    assert.match(deps, /- name: Snyk scan\n\s+if: env\.SNYK_TOKEN != ''/);
    assert.match(deps, /- name: Note Snyk skip[^\n]*\n\s+if: env\.SNYK_TOKEN == ''/);
    assert.match(deps, /::warning title=Snyk skipped::/);
  });

  it("downloads a fixed Trivy release and verifies its published digest before install", () => {
    const triage = workflow("triage-deps.yml");
    assert.doesNotMatch(triage, /curl[^\n|]*\|\s*(?:sh|bash)\b/);
    assert.match(triage, /TRIVY_VERSION:\s*"0\.76\.1"/);
    assert.match(
      triage,
      /TRIVY_SHA256:\s*"c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0"/,
    );
    assert.match(triage, /sha256sum --check/);
  });
});

describe("informational CI jobs can still fail", () => {
  /**
   * F1: the dogfood job's stated purpose is to PROVE kit's provisioning + scan path works
   * end to end. Both of its real steps carried continue-on-error, so the job reported
   * success no matter what happened and proved nothing. Informational has to mean "does
   * not block the gate", which its absence from the gate's needs already achieves, not
   * "cannot fail".
   */
  it("lets the dogfood job fail: its real steps are not swallowed (F1)", () => {
    const security = workflow("security.yml");
    const dogfood = section(security, "dogfood-scan", "gate");
    assert.match(dogfood, /node dist\/cli\.js install/);
    assert.match(dogfood, /run-security-check\.mjs/);
    assert.doesNotMatch(
      dogfood,
      /continue-on-error/,
      "a job that claims to prove something must be able to report failure",
    );
  });

  it("keeps the dogfood job out of the gate, so a red run informs without blocking", () => {
    const gate = workflow("security.yml").slice(workflow("security.yml").indexOf("\n  gate:"));
    const needs = gate.slice(gate.indexOf("needs:"), gate.indexOf("runs-on:"));
    assert.doesNotMatch(needs, /dogfood/);
    assert.match(needs, /self-audit/);
  });
});

describe("GitHub workflow standards gate", () => {
  it("provisions the pinned standards tools and runs the full standards gate in CI", () => {
    const ci = workflow("ci.yml");
    assert.match(ci, /uses:\s*jdx\/mise-action@[a-f0-9]{40}\s*#\s*v5\.\d+\.\d+/);
    assert.match(ci, /run:\s*node dist\/cli\.js standards --enforce/);
    assert.doesNotMatch(
      ci,
      /node dist\/cli\.js standards --enforce[\s\S]{0,80}continue-on-error:\s*true/,
    );
  });
});
