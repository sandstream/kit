import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globToRegExp,
  clustersForPaths,
  readClusters,
  decisionsForPaths,
  getClustersPath,
} from "./clusters.js";
import { shareEntry } from "./shared.js";

describe("memory clusters — glob matching (gap #3)", () => {
  it("** spans path segments, * stays within one", () => {
    assert.match("src/memory/db.ts", globToRegExp("src/memory/**"));
    assert.match("src/memory/sub/deep.ts", globToRegExp("src/memory/**"));
    assert.match("src/secrets-pull.ts", globToRegExp("src/secrets*.ts"));
    assert.doesNotMatch("src/secrets/pull.ts", globToRegExp("src/secrets*.ts")); // * does not cross /
    assert.doesNotMatch("src/other/db.ts", globToRegExp("src/memory/**"));
  });

  it("escapes regex specials in literal segments", () => {
    assert.match("src/a.b.ts", globToRegExp("src/a.b.ts"));
    assert.doesNotMatch("src/axbxts", globToRegExp("src/a.b.ts"));
  });

  it("**/ matches zero or more leading segments", () => {
    assert.match("x.ts", globToRegExp("**/x.ts"));
    assert.match("a/b/x.ts", globToRegExp("**/x.ts"));
  });
});

describe("memory clusters — path → area", () => {
  const MAP = {
    memory: ["src/memory/**"],
    identity: ["src/identity.ts", "src/commands/panic.ts"],
  };

  it("maps touched paths to the right area(s), sorted + deduped", () => {
    assert.deepEqual(clustersForPaths(MAP, ["src/memory/db.ts", "src/memory/hook.ts"]), ["memory"]);
    assert.deepEqual(clustersForPaths(MAP, ["src/commands/panic.ts", "src/identity.ts"]), [
      "identity",
    ]);
    assert.deepEqual(clustersForPaths(MAP, ["src/memory/db.ts", "src/identity.ts"]), [
      "identity",
      "memory",
    ]);
    assert.deepEqual(clustersForPaths(MAP, ["README.md"]), []);
  });

  it("strips a leading ./ and ignores blanks", () => {
    assert.deepEqual(clustersForPaths(MAP, ["./src/memory/db.ts", "", "  "]), ["memory"]);
  });
});

describe("memory clusters — readClusters + decisionsForPaths", () => {
  function tmp(): string {
    return mkdtempSync(join(tmpdir(), "kit-clusters-"));
  }
  function writeMap(root: string, map: unknown): void {
    const p = getClustersPath(root);
    mkdirSync(join(root, ".kit", "shared"), { recursive: true });
    writeFileSync(p, JSON.stringify(map));
  }

  it("returns {} for a missing or malformed map", () => {
    const root = tmp();
    try {
      assert.deepEqual(readClusters(root), {});
      writeMap(root, { memory: "not-an-array", ok: ["a"] });
      assert.deepEqual(readClusters(root), { ok: ["a"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces only ACTIVE decisions for the touched area, dropping empty areas", () => {
    const root = tmp();
    try {
      writeMap(root, { memory: ["src/memory/**"], identity: ["src/identity.ts"] });
      const old = shareEntry(
        root,
        { area: "memory", kind: "decision", title: "use JSON", body: "" },
        "2026-01-01T00:00:00Z",
      );
      shareEntry(
        root,
        { area: "memory", kind: "decision", title: "use JSONL", body: "", supersedes: old.id },
        "2026-02-01T00:00:00Z",
      );
      // touching a memory file surfaces only the ACTIVE (non-superseded) decision
      const groups = decisionsForPaths(root, ["src/memory/db.ts"]);
      assert.equal(groups.length, 1);
      assert.equal(groups[0].area, "memory");
      assert.deepEqual(
        groups[0].decisions.map((d) => d.title),
        ["use JSONL"],
      );
      // touching an area with no decisions yields nothing
      assert.deepEqual(decisionsForPaths(root, ["src/identity.ts"]), []);
      // touching an unmapped path yields nothing
      assert.deepEqual(decisionsForPaths(root, ["README.md"]), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
