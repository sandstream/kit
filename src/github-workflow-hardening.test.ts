import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

  it("downloads a fixed Trivy release and verifies its published digest before install", () => {
    const triage = workflow("triage-deps.yml");
    assert.doesNotMatch(triage, /curl[^\n|]*\|\s*(?:sh|bash)\b/);
    assert.match(triage, /TRIVY_VERSION:\s*"0\.74\.0"/);
    assert.match(
      triage,
      /TRIVY_SHA256:\s*"2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a"/,
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
    assert.match(ci, /uses:\s*jdx\/mise-action@[a-f0-9]{40}\s*#\s*v4\.3\.0/);
    assert.match(ci, /run:\s*node dist\/cli\.js standards --enforce/);
    assert.doesNotMatch(
      ci,
      /node dist\/cli\.js standards --enforce[\s\S]{0,80}continue-on-error:\s*true/,
    );
  });
});
