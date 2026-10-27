import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkMavenSbomCoverage, mavenSbomScanners } from "./maven-sbom.js";
import { runScanners } from "./scanners.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function mavenRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "kit-maven-sbom-"));
  writeFileSync(join(root, "pom.xml"), "<project/>");
  writeFileSync(join(root, ".gitignore"), "target/\n");
  return root;
}

const BOM = JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  components: [{ type: "library", name: "commons-lang3", version: "3.12.0" }],
});

describe("Maven SBOM coverage", () => {
  it("says direct dependencies only and gives the aggregate BOM command when a pom has no BOM", async () => {
    const root = mavenRepo();
    try {
      const row = await checkMavenSbomCoverage(root);
      assert.equal(row.status, "warn");
      assert.match(row.detail, /direct dependencies only/i);
      assert.match(row.detail, /mvn org\.cyclonedx:cyclonedx-maven-plugin:makeAggregateBom/);
      assert.match(
        row.suggestion ?? "",
        /mvn org\.cyclonedx:cyclonedx-maven-plugin:makeAggregateBom/,
      );
      assert.deepEqual(mavenSbomScanners(root), []);
    } finally {
      rmTemp(root);
    }
  });

  it("reads an ignored target/bom.json through both explicit scanner inputs", async () => {
    const root = mavenRepo();
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "target", "bom.json"), BOM);
    try {
      const planned = mavenSbomScanners(root, ["grype", "osv-scanner"]);
      const seen: string[][] = [];
      const result = await runScanners(
        {
          resolve: async () => "/usr/bin/fake",
          hasEnv: () => true,
          detect: () => true,
          run: async (_bin, args) => {
            seen.push(args);
            if (args[0] === "sbom:target/bom.json") {
              return {
                ok: true,
                stdout: JSON.stringify({
                  version: "2.1.0",
                  runs: [{ tool: { driver: { name: "grype" } }, results: [] }],
                }),
              };
            }
            if (args.includes("-L") && args.includes("target/bom.json")) {
              return { ok: true, stdout: '{"results":[]}' };
            }
            return { ok: false, stdout: "", stderr: "scanner did not read the BOM" };
          },
        },
        planned,
      );
      assert.equal(seen.length, 2);
      assert.ok(result.runs.every((r) => r.status === "ran"));
      assert.equal((await checkMavenSbomCoverage(root)).status, "pass");
    } finally {
      rmTemp(root);
    }
  });

  it("does not follow an SBOM symlink outside the project", async () => {
    const root = mavenRepo();
    const outside = mkdtempSync(join(tmpdir(), "kit-external-sbom-"));
    mkdirSync(join(root, "target"));
    writeFileSync(join(outside, "bom.json"), BOM);
    symlinkSync(join(outside, "bom.json"), join(root, "target", "bom.json"));
    try {
      assert.deepEqual(mavenSbomScanners(root), []);
      assert.equal((await checkMavenSbomCoverage(root)).status, "warn");
    } finally {
      rmTemp(root);
      rmTemp(outside);
    }
  });

  it("does not report an invalid JSON file as a usable CycloneDX BOM", async () => {
    const root = mavenRepo();
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "target", "bom.json"), "not a BOM");
    try {
      assert.deepEqual(mavenSbomScanners(root), []);
      assert.equal((await checkMavenSbomCoverage(root)).status, "warn");
    } finally {
      rmTemp(root);
    }
  });
});
