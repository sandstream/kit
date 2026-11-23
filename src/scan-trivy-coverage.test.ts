import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { it } from "node:test";
import { settleScanner } from "./scan-result.js";
import { runTrivyWithCoverage } from "./scan-trivy-coverage.js";

const ref = "registry.example/image:1";
const id = "sha256:" + "a".repeat(64);
const native = JSON.stringify({
  SchemaVersion: 2,
  ArtifactName: ref,
  ArtifactType: "container_image",
  Metadata: { ImageID: id, RepoTags: [ref] },
  Results: [
    {
      Target: ref,
      Class: "os-pkgs",
      Type: "fixture",
      Packages: [{ ID: "pkg", Name: "pkg", Version: "1" }],
      Vulnerabilities: [
        { VulnerabilityID: "CVE-FIRST", PkgName: "pkg", InstalledVersion: "1", Severity: "HIGH" },
        { VulnerabilityID: "CVE-SECOND", PkgName: "pkg", InstalledVersion: "1", Severity: "HIGH" },
      ],
      Secrets: [{ RuleID: "EXAMPLE", Severity: "HIGH", Match: "never-print-this" }],
    },
  ],
});

it("redacts secret matches before conversion and preserves downgraded and dropped findings", async () => {
  const args = ["image", "--format", "sarif", "--quiet", ref];
  const calls: string[] = [];
  let inputPath = "";
  const processResult = await runTrivyWithCoverage(
    process.cwd(),
    args,
    "trivy-image",
    async (actual, root) => {
      calls.push(actual[0]!);
      assert.equal(root, realpathSync(process.cwd()));
      if (actual[0] === "image") {
        assert.deepEqual(actual, ["image", "--format", "json", "--quiet", ref, "--list-all-pkgs"]);
        return { ok: true, stdout: native };
      }
      assert.deepEqual(actual.slice(0, -1), ["convert", "--ignorefile", "", "--format", "sarif"]);
      inputPath = actual.at(-1)!;
      const sanitised = readFileSync(inputPath, "utf8");
      assert.doesNotMatch(sanitised, /never-print-this|"Secrets"/);
      const expected = JSON.parse(native);
      delete expected.Results[0].Secrets;
      assert.deepEqual(JSON.parse(sanitised), expected);
      return {
        ok: true,
        stdout: JSON.stringify({
          version: "2.1.0",
          runs: [
            {
              tool: { driver: { name: "Trivy" } },
              results: [
                {
                  ruleId: "CVE-FIRST",
                  level: "note",
                  locations: [{ physicalLocation: { artifactLocation: { uri: "image" } } }],
                  message: { text: "Package: pkg\nInstalled Version: 1\nNative details" },
                },
              ],
            },
          ],
        }),
      };
    },
  );
  assert.deepEqual(calls, ["image", "convert"]);
  assert.equal(existsSync(inputPath), false);
  assert.doesNotMatch(processResult.stdout, /never-print-this/);
  const settled = settleScanner(
    { id: "trivy", bin: "trivy", format: "sarif", args, evidence: "trivy-image" },
    processResult,
  );
  assert.equal(settled.run.status, "partial");
  assert.deepEqual(
    settled.findings?.map(({ name, severity }) => [name, severity]),
    [
      ["Trivy: CVE-FIRST", "low"],
      ["Trivy: CVE-FIRST", "high"],
      ["Trivy: CVE-SECOND", "high"],
      ["Trivy: EXAMPLE", "high"],
    ],
  );
});

it("requires a structured match for the native target and preserves complete evidence after redaction", async () => {
  const args = ["image", "--format", "sarif", ref];
  for (const uri of ["other-image", "image"]) {
    const value = await runTrivyWithCoverage(process.cwd(), args, "trivy-image", async (actual) => {
      if (actual[0] === "image") return { ok: true, stdout: native };
      return {
        ok: true,
        stdout: JSON.stringify({
          version: "2.1.0",
          runs: [
            {
              tool: { driver: { name: "Trivy" } },
              results: ["CVE-FIRST", "CVE-SECOND"].map((ruleId) => ({
                ruleId,
                level: "error",
                message: { text: "Package: pkg\nInstalled Version: 1\nNative details (image)" },
                locations: [{ physicalLocation: { artifactLocation: { uri } } }],
              })),
            },
          ],
        }),
      };
    });
    assert.equal(value.evidence?.status, uri === "image" ? "complete" : "partial");
    assert.match(value.stdout, /Trivy reported a secret finding/);
    assert.doesNotMatch(value.stdout, /never-print-this/);
  }
});

it("does not let duplicates at one line replace a native finding at another", async () => {
  const report = JSON.parse(native);
  const [finding] = report.Results[0].Vulnerabilities;
  report.Results[0].Vulnerabilities = [
    { ...finding, StartLine: 2 },
    { ...finding, StartLine: 7 },
  ];
  delete report.Results[0].Secrets;
  const args = ["image", "--format", "sarif", ref];
  const value = await runTrivyWithCoverage(
    process.cwd(),
    args,
    "trivy-image",
    async ([command]) => {
      if (command === "image") return { ok: true, stdout: JSON.stringify(report) };
      const repeated = {
        ruleId: "CVE-FIRST",
        level: "error",
        message: { text: "Package: pkg\nInstalled Version: 1\nNative details" },
        locations: [
          {
            physicalLocation: { artifactLocation: { uri: "image" }, region: { startLine: 2 } },
          },
        ],
      };
      return {
        ok: true,
        stdout: JSON.stringify({
          version: "2.1.0",
          runs: [{ tool: { driver: { name: "Trivy" } }, results: [repeated, repeated] }],
        }),
      };
    },
  );
  assert.equal(value.evidence?.status, "partial");
  assert.match(value.stdout, /"startLine":7/);
});
