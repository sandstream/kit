import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTarget,
  sha256,
  parseScanOutput,
  maxSeverity,
  isCatalogStale,
  CATALOG_STALE_AFTER_DAYS,
  IntegrityError,
  TARBALL_CHECKSUMS,
  BUMBLEBEE_VERSION,
  type BumblebeeFinding,
} from "./bumblebee.js";

describe("resolveTarget", () => {
  it("maps linux/x64 to the linux amd64 asset with its checksum", () => {
    const t = resolveTarget("linux", "x64");
    assert.ok(t);
    assert.equal(t.os, "linux");
    assert.equal(t.arch, "amd64");
    assert.equal(t.assetName, `bumblebee_${BUMBLEBEE_VERSION}_linux_amd64.tar.gz`);
    assert.equal(t.checksum, TARBALL_CHECKSUMS[t.assetName]);
  });

  it("maps darwin/arm64 to the darwin arm64 asset", () => {
    const t = resolveTarget("darwin", "arm64");
    assert.ok(t);
    assert.equal(t.assetName, `bumblebee_${BUMBLEBEE_VERSION}_darwin_arm64.tar.gz`);
  });

  it("returns null on unsupported OS (windows)", () => {
    assert.equal(resolveTarget("win32", "x64"), null);
  });

  it("returns null on unsupported arch", () => {
    assert.equal(resolveTarget("linux", "ia32"), null);
  });

  it("every shipped asset has a checksum", () => {
    for (const os of ["linux", "darwin"] as const) {
      for (const arch of ["x64", "arm64"] as const) {
        const t = resolveTarget(os, arch);
        assert.ok(t, `${os}/${arch} should resolve`);
        assert.match(t.checksum, /^[0-9a-f]{64}$/);
      }
    }
  });
});

describe("sha256", () => {
  it("hashes the empty buffer to the known digest", () => {
    assert.equal(
      sha256(Buffer.from("")),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("parseScanOutput", () => {
  it("parses a clean scan (summary only, no findings)", () => {
    const ndjson = [
      JSON.stringify({
        record_type: "scan_summary",
        status: "complete",
        timed_out: false,
        package_records_emitted: 0,
        package_records_suppressed: 152,
      }),
    ].join("\n");

    const out = parseScanOutput(ndjson);
    assert.equal(out.summarySeen, true);
    assert.equal(out.status, "complete");
    assert.equal(out.timedOut, false);
    assert.equal(out.findings.length, 0);
    assert.equal(out.packagesScanned, 152);
  });

  it("parses findings and ignores blank/garbage/diagnostic lines", () => {
    const ndjson = [
      "",
      "not json at all",
      JSON.stringify({ record_type: "diagnostic", level: "info", message: "scan complete" }),
      JSON.stringify({
        record_type: "finding",
        finding_type: "package_exposure",
        severity: "critical",
        catalog_id: "socket-2026-05-19-go-shopsprint-decimal-typosquat",
        catalog_name: "github.com/shopsprint/decimal v1.3.3 (typosquat DNS backdoor)",
        ecosystem: "go",
        package_name: "github.com/shopsprint/decimal",
        version: "v1.3.3",
        source_file: "fix/goproj/go.sum",
        evidence: "exact name+version match (version=v1.3.3)",
      }),
      JSON.stringify({
        record_type: "scan_summary",
        status: "complete",
        timed_out: false,
        counts: { finding: 1, package: 0 },
        package_records_emitted: 0,
        package_records_suppressed: 2,
      }),
    ].join("\n");

    const out = parseScanOutput(ndjson);
    assert.equal(out.findings.length, 1);
    const f = out.findings[0];
    assert.equal(f.severity, "critical");
    assert.equal(f.ecosystem, "go");
    assert.equal(f.packageName, "github.com/shopsprint/decimal");
    assert.equal(f.version, "v1.3.3");
    assert.equal(f.sourceFile, "fix/goproj/go.sum");
    assert.equal(out.summarySeen, true);
    assert.equal(out.packagesScanned, 2);
  });

  it("falls back to package_name from normalized_name when absent", () => {
    const ndjson = JSON.stringify({
      record_type: "finding",
      severity: "high",
      normalized_name: "left-pad",
      version: "1.0.0",
    });
    const out = parseScanOutput(ndjson);
    assert.equal(out.findings[0].packageName, "left-pad");
  });

  it("reports no summary when none is present", () => {
    const out = parseScanOutput("");
    assert.equal(out.summarySeen, false);
    assert.equal(out.status, "unknown");
    assert.equal(out.findings.length, 0);
  });
});

describe("maxSeverity", () => {
  const mk = (severity: string): BumblebeeFinding => ({
    severity,
    catalogId: "",
    catalogName: "",
    ecosystem: "",
    packageName: "",
    version: "",
    sourceFile: "",
    evidence: "",
  });

  it("returns the highest-ranked label", () => {
    assert.equal(maxSeverity([mk("low"), mk("critical"), mk("high")]), "critical");
    assert.equal(maxSeverity([mk("low"), mk("medium")]), "medium");
  });

  it("returns null for no findings", () => {
    assert.equal(maxSeverity([]), null);
  });

  it("handles unknown labels without throwing", () => {
    assert.equal(maxSeverity([mk("weird")]), "weird");
    assert.equal(maxSeverity([mk("weird"), mk("high")]), "high");
  });
});

describe("isCatalogStale", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 4, 26);

  it("is not stale within the threshold", () => {
    const r = isCatalogStale(now - 10 * DAY, now);
    assert.equal(r.stale, false);
    assert.equal(r.ageDays, 10);
  });

  it("is stale past the threshold", () => {
    const r = isCatalogStale(now - (CATALOG_STALE_AFTER_DAYS + 5) * DAY, now);
    assert.equal(r.stale, true);
    assert.equal(r.ageDays, CATALOG_STALE_AFTER_DAYS + 5);
  });

  it("is not stale exactly at the threshold", () => {
    assert.equal(isCatalogStale(now - CATALOG_STALE_AFTER_DAYS * DAY, now).stale, false);
  });

  it("clamps a future mtime to age 0", () => {
    const r = isCatalogStale(now + 5 * DAY, now);
    assert.equal(r.ageDays, 0);
    assert.equal(r.stale, false);
  });

  it("respects a custom threshold", () => {
    assert.equal(isCatalogStale(now - 3 * DAY, now, 2).stale, true);
    assert.equal(isCatalogStale(now - 1 * DAY, now, 2).stale, false);
  });
});

describe("IntegrityError", () => {
  it("is an Error subclass identifiable via instanceof", () => {
    const e = new IntegrityError("checksum mismatch");
    assert.ok(e instanceof IntegrityError);
    assert.ok(e instanceof Error);
    assert.equal(e.name, "IntegrityError");
  });
});
