import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkMavenSbomCoverage, mavenSbomScanners, planMavenSbomScans } from "./maven-sbom.js";
import { runScanners } from "./scanners.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";

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

function writeBom(project: string, body = BOM): string {
  mkdirSync(join(project, "target"), { recursive: true });
  const path = join(project, "target", "bom.json");
  writeFileSync(path, body);
  return path;
}

function addProject(root: string, path: string, pom = "<project/>"): string {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pom.xml"), pom);
  return dir;
}

function gapKinds(plan: ReturnType<typeof planMavenSbomScans>): string[][] {
  return plan.gaps.map(({ target, evidenceStatus }) => [target, evidenceStatus]).sort();
}

describe("Maven SBOM input and delegates", () => {
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
      assert.deepEqual(gapKinds(planMavenSbomScans(root, ["osv-scanner"])), [[".", "missing"]]);
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
      const coverage = await checkMavenSbomCoverage(root);
      assert.equal(coverage.status, "pass");
      assert.match(coverage.detail, /confirms input availability/);
      assert.equal(coverage.evidenceStatus, undefined);
    } finally {
      rmTemp(root);
    }
  });
});

describe("Maven SBOM validation", () => {
  it("does not follow an SBOM symlink outside the project", async () => {
    const root = mavenRepo();
    const outside = mkdtempSync(join(tmpdir(), "kit-external-sbom-"));
    mkdirSync(join(root, "target"));
    writeFileSync(join(outside, "bom.json"), BOM);
    symlinkSync(join(outside, "bom.json"), join(root, "target", "bom.json"));
    try {
      assert.deepEqual(mavenSbomScanners(root), []);
      assert.deepEqual(gapKinds(planMavenSbomScans(root)), [[".", "unsupported"]]);
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
      assert.deepEqual(gapKinds(planMavenSbomScans(root)), [[".", "malformed"]]);
      assert.equal((await checkMavenSbomCoverage(root)).status, "warn");
    } finally {
      rmTemp(root);
    }
  });
});

describe("Maven reactor coverage", () => {
  it("uses a root aggregate BOM for declared Maven modules, but not unrelated POMs", async () => {
    const root = mavenRepo();
    writeFileSync(
      join(root, "pom.xml"),
      "<project><modules><module>backend</module></modules></project>",
    );
    mkdirSync(join(root, "backend"));
    mkdirSync(join(root, "unrelated"));
    writeFileSync(join(root, "backend", "pom.xml"), "<project/>");
    writeFileSync(join(root, "unrelated", "pom.xml"), "<project/>");
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "target", "bom.json"), BOM);
    try {
      const row = await checkMavenSbomCoverage(root);
      assert.equal(row.status, "warn");
      assert.match(row.detail, /unrelated/);
      assert.doesNotMatch(row.detail, /backend/);
      assert.deepEqual(gapKinds(planMavenSbomScans(root)), [["unrelated", "missing"]]);
      assert.deepEqual(
        mavenSbomScanners(root, ["grype"]).map((scanner) => scanner.id),
        ["grype-sbom:."],
      );
    } finally {
      rmTemp(root);
    }
  });

  it("accepts a root aggregate BOM when every nested POM is a declared module", async () => {
    const root = mavenRepo();
    writeFileSync(
      join(root, "pom.xml"),
      '<?xml version="1.0"?>\n<m:project xmlns:m="http://maven.apache.org/POM/4.0.0">' +
        "<m:modules><m:module>backend</m:module></m:modules></m:project>",
    );
    mkdirSync(join(root, "backend"));
    writeFileSync(join(root, "backend", "pom.xml"), "<project/>");
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "target", "bom.json"), BOM);
    try {
      assert.equal((await checkMavenSbomCoverage(root)).status, "pass");
      const plan = planMavenSbomScans(root, ["grype"]);
      assert.deepEqual(plan.gaps, []);
      assert.deepEqual(
        plan.scanners.map((scanner) => scanner.id),
        ["grype-sbom:."],
      );
    } finally {
      rmTemp(root);
    }
  });

  it("does not infer aggregate coverage from commented or profile-only modules", async () => {
    const root = mavenRepo();
    writeFileSync(
      join(root, "pom.xml"),
      "<project><!-- <modules><module>backend</module></modules> -->" +
        "<profiles><profile><modules><module>backend</module></modules></profile></profiles></project>",
    );
    mkdirSync(join(root, "backend"));
    writeFileSync(join(root, "backend", "pom.xml"), "<project/>");
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "target", "bom.json"), BOM);
    try {
      const row = await checkMavenSbomCoverage(root);
      assert.equal(row.status, "warn");
      assert.match(row.detail, /backend/);
    } finally {
      rmTemp(root);
    }
  });
});

describe("Inherited Maven reactor coverage", () => {
  it("credits a declared subproject with the reactor root's aggregate BOM", async () => {
    const root = mavenRepo();
    writeFileSync(
      join(root, "pom.xml"),
      "<project><modules><module>backend</module></modules></project>",
    );
    mkdirSync(join(root, "backend"));
    writeFileSync(join(root, "backend", "pom.xml"), "<project/>");
    mkdirSync(join(root, "target"));
    writeFileSync(join(root, "target", "bom.json"), BOM);
    execFileSync("git", ["init", "-q"], { cwd: root });
    try {
      assert.equal((await checkMavenSbomCoverage(join(root, "backend"))).status, "pass");
      const plan = planMavenSbomScans(join(root, "backend"), ["grype", "osv-scanner"]);
      assert.deepEqual(plan.gaps, []);
      const { scanners } = plan;
      assert.equal(scanners.length, 2);
      const aggregateBom = join(root, "target", "bom.json");
      assert.ok(scanners[0].args[0].startsWith("sbom:"));
      assert.ok(sameIdentity(identityOf(scanners[0].args[0].slice(5)), identityOf(aggregateBom)));
      const osvInput = scanners[1].args[scanners[1].args.indexOf("-L") + 1];
      assert.ok(sameIdentity(identityOf(osvInput), identityOf(aggregateBom)));
    } finally {
      rmTemp(root);
    }
  });
});

describe("Maven SBOM scan plan", () => {
  it("retains valid peers when a BOM is missing or malformed, and honors the delegate list", () => {
    const root = mavenRepo();
    try {
      writeBom(addProject(root, "broken"), '{"bomFormat":"CycloneDX","specVersion":""}');
      writeBom(addProject(root, "valid"));
      const plan = planMavenSbomScans(root, ["osv-scanner"]);
      assert.deepEqual(gapKinds(plan), [
        [".", "missing"],
        ["broken", "malformed"],
      ]);
      assert.deepEqual(
        plan.scanners.map((scanner) => scanner.id),
        ["osv-scanner-sbom:valid"],
      );
      assert.deepEqual(mavenSbomScanners(root, ["osv-scanner"]), plan.scanners);
      assert.deepEqual(planMavenSbomScans(root, ["trivy"]), { scanners: [], gaps: [] });
      assert.deepEqual(planMavenSbomScans(root, []), planMavenSbomScans(root));
    } finally {
      rmTemp(root);
    }
  });

  it("keeps the standalone check optional when no POM was found", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-maven-scope-"));
    try {
      mkdirSync(join(root, "target", "a", "b", "c"), { recursive: true });
      assert.deepEqual(planMavenSbomScans(root), { scanners: [], gaps: [] });
      mkdirSync(join(root, "a", "b", "c", "d"), { recursive: true });
      assert.deepEqual(gapKinds(planMavenSbomScans(root)), [["a/b/c", "partial"]]);
      const coverage = await checkMavenSbomCoverage(root);
      assert.equal(coverage.status, "skip");
      assert.equal(coverage.didNotRun, undefined);
      const missing = join(root, "missing");
      assert.deepEqual(gapKinds(planMavenSbomScans(missing)), [[".", "unavailable"]]);
      assert.deepEqual(planMavenSbomScans(missing, ["trivy"]), { scanners: [], gaps: [] });
    } finally {
      rmTemp(root);
    }
  });
});

describe("Maven discovery gaps", () => {
  it("reports a depth cutoff and still schedules reachable BOMs", async () => {
    const root = mavenRepo();
    try {
      writeBom(root);
      addProject(root, "a/b/c/hidden");
      const plan = planMavenSbomScans(root, ["grype"]);
      assert.deepEqual(gapKinds(plan), [["a/b/c", "partial"]]);
      assert.match(plan.gaps[0].reason, /depth limit/);
      assert.deepEqual(
        plan.scanners.map((scanner) => scanner.id),
        ["grype-sbom:."],
      );
      const coverage = await checkMavenSbomCoverage(root);
      assert.equal(coverage.status, "warn");
      assert.equal(coverage.evidenceStatus, "partial");
      assert.equal(coverage.didNotRun, true);
      assert.match(coverage.detail, /a\/b\/c.*depth limit/);
    } finally {
      rmTemp(root);
    }
  });

  it(
    "reports an unreadable directory without dropping readable peers",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    async () => {
      const root = mavenRepo();
      const unreadable = addProject(root, "unreadable");
      try {
        writeBom(root);
        chmodSync(unreadable, 0o000);
        const plan = planMavenSbomScans(root, ["grype"]);
        assert.deepEqual(gapKinds(plan), [["unreadable", "unavailable"]]);
        assert.equal(plan.scanners.length, 1);
        const coverage = await checkMavenSbomCoverage(root);
        assert.equal(coverage.status, "warn");
        assert.equal(coverage.evidenceStatus, "unavailable");
        assert.match(coverage.detail, /unreadable/);
      } finally {
        chmodSync(unreadable, 0o700);
        rmTemp(root);
      }
    },
  );

  it("bounds POM and BOM reads without dropping a usable BOM", () => {
    const root = mavenRepo();
    try {
      writeBom(root);
      truncateSync(join(root, "pom.xml"), 4 * 1024 * 1024 + 1);
      truncateSync(writeBom(addProject(root, "oversized")), 64 * 1024 * 1024 + 1);
      const plan = planMavenSbomScans(root, ["grype"]);
      assert.deepEqual(gapKinds(plan), [
        [".", "partial"],
        ["oversized", "partial"],
      ]);
      assert.ok(plan.gaps.every((gap) => gap.reason.includes("size limit")));
      assert.deepEqual(
        plan.scanners.map((scanner) => scanner.id),
        ["grype-sbom:."],
      );
    } finally {
      rmTemp(root);
    }
  });
});

describe("Maven POM evidence", () => {
  it("does not infer reactor coverage from a truncated POM", () => {
    const root = mavenRepo();
    try {
      writeFileSync(join(root, "pom.xml"), "<project><modules><module>backend</module></modules>");
      addProject(root, "backend");
      writeBom(root);
      const plan = planMavenSbomScans(root, ["grype"]);
      assert.deepEqual(gapKinds(plan), [
        [".", "malformed"],
        ["backend", "missing"],
      ]);
      assert.deepEqual(
        plan.scanners.map((scanner) => scanner.id),
        ["grype-sbom:."],
      );
    } finally {
      rmTemp(root);
    }
  });

  it("warns on a malformed POM even with usable CycloneDX input", async () => {
    const root = mavenRepo();
    try {
      writeFileSync(join(root, "pom.xml"), "<project><modules></project>");
      writeBom(root);
      const coverage = await checkMavenSbomCoverage(root);
      assert.equal(coverage.status, "warn");
      assert.equal(coverage.evidenceStatus, "malformed");
      assert.equal(coverage.scanIncomplete, true);
      assert.match(coverage.detail, /pom\.xml/);
      assert.equal(planMavenSbomScans(root, ["grype"]).scanners.length, 1);
    } finally {
      rmTemp(root);
    }
  });

  it("passes with a complete reactor and conventional source trees deeper than the cutoff", async () => {
    const root = mavenRepo();
    try {
      writeFileSync(
        join(root, "pom.xml"),
        "<project><modules><module>a/b/c</module></modules></project>",
      );
      const child = addProject(root, "a/b/c");
      mkdirSync(join(root, "src", "main", "java", "org", "example"), { recursive: true });
      mkdirSync(join(root, "src", "test", "resources", "org", "example"), { recursive: true });
      mkdirSync(join(child, "src", "main", "java", "org", "example"), { recursive: true });
      writeBom(root);
      assert.deepEqual(planMavenSbomScans(root, ["grype"]).gaps, []);
      assert.equal((await checkMavenSbomCoverage(root)).status, "pass");
    } finally {
      rmTemp(root);
    }
  });

  it("reports a declared module below the cutoff even inside the conventional source tree", () => {
    const root = mavenRepo();
    try {
      writeFileSync(
        join(root, "pom.xml"),
        "<project><modules><module>src/main/java/backend</module></modules></project>",
      );
      addProject(root, "src/main/java/backend");
      writeBom(root);
      const plan = planMavenSbomScans(root, ["grype"]);
      assert.deepEqual(gapKinds(plan), [[".", "partial"]]);
      assert.match(plan.gaps[0].reason, /declared reactor modules/);
      assert.equal(plan.scanners.length, 1);
    } finally {
      rmTemp(root);
    }
  });
});
