import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { readTrivyReport } from "./scan-trivy-report.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const fsReport = { SchemaVersion: 2, ArtifactType: "filesystem", ArtifactName: "." };
const pkg = { ID: "fixture@1.0.0", Name: "fixture", Version: "1.0.0" };
const target = { Class: "lang-pkgs", Type: "npm", Target: "package-lock.json", Packages: [pkg] };

it("requires a real local target and distinguishes no inventory from checked packages", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-trivy-scope-")));
  try {
    writeFileSync(join(root, "package-lock.json"), "{}");
    const read = (value: object) => readTrivyReport(JSON.stringify(value), "trivy-fs", ".", root);
    assert.equal(read(fsReport).evidence.status, "not-applicable");
    assert.deepEqual(read({ ...fsReport, Results: [target] }).evidence, {
      status: "complete",
      packageCount: 1,
    });
    const finding = {
      VulnerabilityID: "CVE-FIXTURE",
      PkgName: pkg.Name,
      InstalledVersion: pkg.Version,
    };
    const damaged = read({
      ...fsReport,
      Results: [{ ...target, Target: "../package-lock.json", Vulnerabilities: [finding] }],
    });
    assert.equal(damaged.evidence.status, "partial");
    assert.deepEqual(
      damaged.findings.map(({ id }) => id),
      ["CVE-FIXTURE"],
    );
    assert.equal(
      read({
        ...fsReport,
        Results: [{ ...target, Vulnerabilities: [{ ...finding, InstalledVersion: "2.0.0" }] }],
      }).evidence.status,
      "partial",
    );
    assert.equal(
      read({
        ...fsReport,
        Results: [{ ...target, Vulnerabilities: [{ ...finding, Severity: {} }] }],
      }).evidence.status,
      "partial",
    );
    assert.deepEqual(readTrivyReport("{}", "trivy-fs", ".", root).evidence.status, "partial");
  } finally {
    await rmTemp(root);
  }
});

it("requires configuration check counts and reconciliation of reported failures", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-trivy-config-scope-")));
  try {
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");
    const config = { Class: "config", Type: "dockerfile", Target: "Dockerfile" };
    const read = (row: object) =>
      readTrivyReport(
        JSON.stringify({
          ...fsReport,
          Results: [{ ...config, ...row }],
        }),
        "trivy-config",
        ".",
        root,
      );
    assert.deepEqual(read({ MisconfSummary: { Successes: 27, Failures: 0 } }).evidence, {
      status: "complete",
      checkCount: 27,
    });
    assert.equal(
      read({ MisconfSummary: { Successes: 26, Failures: 1 } }).evidence.status,
      "partial",
    );
    const result = read({
      MisconfSummary: { Successes: 26, Failures: 1 },
      Misconfigurations: [
        { ID: "PASS", Status: "PASS" },
        { ID: "FAIL", Status: "FAIL", Severity: "LOW" },
      ],
    });
    assert.equal(result.evidence.status, "complete");
    assert.deepEqual(
      result.findings.map(({ id }) => id),
      ["FAIL"],
    );
  } finally {
    await rmTemp(root);
  }
});

it("binds an image inventory to the requested tag or digest", () => {
  const id = "sha256:" + "a".repeat(64);
  const tag = "alpine:3.23";
  const digest = "alpine@" + id;
  const base = {
    SchemaVersion: 2,
    ArtifactType: "container_image",
    Metadata: { ImageID: id, RepoTags: [tag], RepoDigests: [digest] },
    Results: [{ ...target, Class: "os-pkgs", Target: "alpine (alpine 3.23)" }],
  };
  const read = (reference: string) =>
    readTrivyReport(
      JSON.stringify({ ...base, ArtifactName: reference }),
      "trivy-image",
      reference,
      "/unused",
    );
  assert.equal(read(tag).evidence.status, "complete");
  assert.equal(read(digest).evidence.status, "complete");
  assert.equal(read("alpine:other").evidence.status, "partial");
  assert.equal(read("alpine@sha256:" + "b".repeat(64)).evidence.status, "partial");
});

it("requires coverage of each Terraform module and never counts it as package coverage", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-trivy-terraform-scope-")));
  try {
    mkdirSync(join(root, "infra"));
    writeFileSync(join(root, "main.tf"), "");
    writeFileSync(join(root, "infra/main.tf"), "");
    const row = {
      Class: "config",
      Type: "terraform",
      Target: ".",
      MisconfSummary: { Successes: 1 },
    };
    const file = {
      ...row,
      Target: "main.tf",
      MisconfSummary: { Failures: 1 },
      Misconfigurations: [{ ID: "FAIL", Status: "FAIL", Severity: "HIGH" }],
    };
    const text = JSON.stringify({ ...fsReport, Results: [row, file] });
    const readConfig = (results: object[], expected: string[]) =>
      readTrivyReport(
        JSON.stringify({ ...fsReport, Results: results }),
        "trivy-config",
        ".",
        root,
        expected,
      );
    assert.equal(readConfig([file], ["main.tf"]).evidence.status, "complete");
    assert.equal(
      readConfig(
        [row, { ...row, Target: "infra", MisconfSummary: { Exceptions: 1 } }],
        ["main.tf", "infra/main.tf"],
      ).evidence.status,
      "partial",
    );
    const config = readTrivyReport(text, "trivy-config", ".", root, ["main.tf"]);
    assert.equal(config.findings[0]?.target, "main.tf");
    assert.equal(
      readTrivyReport(text, "trivy-config", ".", root, ["main.tf"]).evidence.status,
      "complete",
    );
    assert.equal(
      readTrivyReport(text, "trivy-config", ".", root, ["main.tf", "infra/main.tf"]).evidence
        .status,
      "partial",
    );
    assert.equal(
      readTrivyReport(JSON.stringify({ ...fsReport, Results: [row] }), "trivy-fs", ".", root)
        .evidence.status,
      "not-applicable",
    );
    writeFileSync(join(root, "package-lock.json"), "{}");
    const truncated = JSON.stringify({
      ...fsReport,
      Results: [target, { ...target, Packages: undefined }],
    });
    assert.equal(readTrivyReport(truncated, "trivy-fs", ".", root).evidence.status, "partial");
  } finally {
    await rmTemp(root);
  }
});
