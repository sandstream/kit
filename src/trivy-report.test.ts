import assert from "node:assert/strict";
import { it } from "node:test";
import { readTrivyReport } from "./trivy-report.js";

const trivy = { SchemaVersion: 2, ArtifactType: "filesystem", ArtifactName: "." };

it("counts high Trivy findings only for the intended scan and failure status", () => {
  const report = JSON.stringify({
    ...trivy,
    Results: [
      {
        Target: "Dockerfile",
        Class: "config",
        Type: "dockerfile",
        Misconfigurations: [
          { ID: "first", Severity: "HIGH", Status: "FAIL" },
          { ID: "second", Severity: "LOW", Status: "FAIL" },
          { ID: "third", Severity: "CRITICAL", Status: "PASS" },
          { ID: "fourth", Severity: "HIGH", Status: "EXCEPTION" },
        ],
      },
    ],
  });
  assert.deepEqual(readTrivyReport(report, "configuration"), { count: 1 });
  assert.deepEqual(readTrivyReport(report, "vulnerability"), { count: 0, gap: "missing" });
});

it("counts readable vulnerabilities beside damaged Trivy records", () => {
  const report = JSON.stringify({
    ...trivy,
    Results: [
      {
        Target: "pom.xml",
        Class: "lang-pkgs",
        Type: "pom",
        Vulnerabilities: [
          { VulnerabilityID: "CVE-2026-12345", Severity: "HIGH" },
          { VulnerabilityID: "CVE-2026-12346", Severity: "CRITICAL" },
          null,
        ],
      },
    ],
  });
  assert.deepEqual(readTrivyReport(report, "vulnerability"), { count: 2, gap: "partial" });
});

it("ignores unrelated secret rows without a package type", () => {
  const secret = { Target: "fixture.txt", Class: "secret", Secrets: [] };
  const npm = { Target: "package-lock.json", Class: "lang-pkgs", Type: "npm" };
  assert.deepEqual(
    readTrivyReport(JSON.stringify({ ...trivy, Results: [npm, secret] }), "vulnerability"),
    { count: 0 },
  );
  assert.equal(
    readTrivyReport(JSON.stringify({ ...trivy, Results: [secret] }), "vulnerability").gap,
    "missing",
  );
});

it("refuses clean configuration coverage when Trivy omitted declared failures", () => {
  const target = {
    Target: "Dockerfile",
    Class: "config",
    Type: "dockerfile",
    MisconfSummary: { Failures: 2 },
  };
  const missing = JSON.stringify({ ...trivy, Results: [target] });
  assert.deepEqual(readTrivyReport(missing, "configuration"), { count: 0, gap: "partial" });
  const withFinding = {
    ...target,
    Misconfigurations: [{ ID: "fixture", Severity: "HIGH", Status: "FAIL" }],
  };
  assert.deepEqual(
    readTrivyReport(JSON.stringify({ ...trivy, Results: [withFinding] }), "configuration"),
    { count: 1, gap: "partial" },
  );
});

it("preserves jar findings but requires the matching JVM manifest for coverage", () => {
  const jar = {
    Target: "artifact.jar",
    Class: "lang-pkgs",
    Type: "jar",
    Vulnerabilities: [{ VulnerabilityID: "CVE-2026-12345", Severity: "HIGH" }],
  };
  const pom = { Target: "pom.xml", Class: "lang-pkgs", Type: "pom" };
  assert.deepEqual(readTrivyReport(JSON.stringify({ ...trivy, Results: [jar] }), "maven"), {
    count: 1,
    gap: "partial",
  });
  assert.deepEqual(readTrivyReport(JSON.stringify({ ...trivy, Results: [pom, jar] }), "maven"), {
    count: 1,
  });
  assert.deepEqual(readTrivyReport(JSON.stringify({ ...trivy, Results: [pom, jar] }), "gradle"), {
    count: 1,
    gap: "partial",
  });
});

it("matches expected Terraform directories and exact Dockerfile targets", () => {
  const results = [
    { Target: ".", Class: "config", Type: "terraform" },
    { Target: "infra", Class: "config", Type: "terraform" },
    { Target: "docker/Dockerfile", Class: "config", Type: "dockerfile" },
  ];
  const raw = JSON.stringify({ ...trivy, Results: results });
  const files = ["main.tf", "infra/a.tf", "infra/b.tf", "docker/Dockerfile"];
  assert.deepEqual(readTrivyReport(raw, "configuration", files), { count: 0 });
  assert.deepEqual(readTrivyReport(raw, "configuration", [...files, "compose.yaml"]), {
    count: 0,
    gap: "partial",
    note: "Trivy reported 3 of 4 expected configuration target(s)",
  });
  assert.equal(
    readTrivyReport('{"version":"2.1.0","runs":[]}', "configuration").gap,
    "unsupported",
  );
});

it("distinguishes omitted targets, invalid data and an unsupported schema", () => {
  assert.equal(readTrivyReport(JSON.stringify(trivy), "configuration").gap, "missing");
  assert.equal(readTrivyReport("{}", "configuration").gap, "malformed");
  assert.equal(
    readTrivyReport(JSON.stringify({ ...trivy, SchemaVersion: 9 }), "configuration").gap,
    "unsupported",
  );
  assert.equal(
    readTrivyReport(JSON.stringify({ ...trivy, Results: null }), "configuration").gap,
    "malformed",
  );
});
