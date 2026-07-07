import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depsHashFor, loadGuardDogCache, saveGuardDogCache } from "./guarddog-cache.js";

describe("guarddog verdict cache (#205)", () => {
  it("depsHashFor is stable across key order, changes with any dep change", () => {
    const a = depsHashFor(JSON.stringify({ dependencies: { x: "1.0.0", y: "2.0.0" } }));
    const b = depsHashFor(JSON.stringify({ dependencies: { y: "2.0.0", x: "1.0.0" } }));
    assert.equal(a, b);
    const bumped = depsHashFor(JSON.stringify({ dependencies: { x: "1.0.1", y: "2.0.0" } }));
    assert.notEqual(a, bumped);
    const added = depsHashFor(
      JSON.stringify({ dependencies: { x: "1.0.0", y: "2.0.0" }, devDependencies: { z: "3" } }),
    );
    assert.notEqual(a, added);
  });

  it("returns null for an unparseable manifest — no caching on missing evidence", () => {
    assert.equal(depsHashFor("{broken"), null);
  });

  it("round-trips a verdict; a missing/corrupt cache reads as null", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-gd-"));
    const path = join(dir, "cache.json");
    assert.equal(loadGuardDogCache(path), null);
    saveGuardDogCache({ depsHash: "abc", scannedAt: "2026-07-07T00:00:00Z", packages: 12 }, path);
    const loaded = loadGuardDogCache(path);
    assert.equal(loaded?.depsHash, "abc");
    assert.equal(loaded?.packages, 12);
    rmSync(dir, { recursive: true, force: true });
  });
});
