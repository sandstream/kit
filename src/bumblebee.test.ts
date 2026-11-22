import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTarget,
  sha256,
  maxSeverity,
  isCatalogStale,
  CATALOG_STALE_AFTER_DAYS,
  IntegrityError,
  TARBALL_CHECKSUMS,
  BUMBLEBEE_VERSION,
  ensureBumblebee,
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

describe("ensureBumblebee — cache reuse verifies the binary against its sidecar (F3)", () => {
  const bin = Buffer.from("fake-bumblebee-binary-bytes");
  const goodHash = sha256(bin);

  // Build an isolated cache (KIT_BUMBLEBEE_CACHE) holding a binary + catalog and,
  // unless sidecar:null, a `bumblebee.sha256` recording the binary's hash.
  async function makeCache(opts: { sidecar?: string | null } = {}): Promise<{
    cache: string;
    restore: () => void;
  }> {
    const cache = await mkdtemp(join(tmpdir(), "kit-bb-"));
    const verDir = join(cache, BUMBLEBEE_VERSION);
    await mkdir(join(verDir, "threat_intel"), { recursive: true });
    await writeFile(join(verDir, "bumblebee"), bin);
    if (opts.sidecar !== null) {
      await writeFile(join(verDir, "bumblebee.sha256"), `${opts.sidecar ?? goodHash}\n`);
    }
    const prev = process.env.KIT_BUMBLEBEE_CACHE;
    process.env.KIT_BUMBLEBEE_CACHE = cache;
    return {
      cache,
      restore: () => {
        if (prev === undefined) delete process.env.KIT_BUMBLEBEE_CACHE;
        else process.env.KIT_BUMBLEBEE_CACHE = prev;
      },
    };
  }

  it("reuses the cached binary when it matches its sidecar", async () => {
    const { cache, restore } = await makeCache();
    try {
      const res = await ensureBumblebee({ allowDownload: false });
      assert.ok("install" in res && res.install, `expected reuse, got ${JSON.stringify(res)}`);
    } finally {
      restore();
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("flags integrity when the cached binary no longer matches its sidecar", async () => {
    const { cache, restore } = await makeCache({ sidecar: "0".repeat(64) });
    try {
      const res = await ensureBumblebee({ allowDownload: false });
      assert.equal("kind" in res ? res.kind : null, "integrity");
    } finally {
      restore();
      await rm(cache, { recursive: true, force: true });
    }
  });

  it("does NOT silently reuse a legacy cache with no sidecar", async () => {
    const { cache, restore } = await makeCache({ sidecar: null });
    try {
      // No sidecar → falls through to the (here disabled) download path rather
      // than trusting an unverifiable legacy binary.
      const res = await ensureBumblebee({ allowDownload: false });
      assert.equal("kind" in res ? res.kind : null, "network");
    } finally {
      restore();
      await rm(cache, { recursive: true, force: true });
    }
  });
});
