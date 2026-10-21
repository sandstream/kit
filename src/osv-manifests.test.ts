import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { hasOsvManifest } from "./osv-manifests.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

async function inTempDir(files: string[], body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "kit-osv-"));
  try {
    for (const file of files) {
      const full = join(dir, file);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, "");
    }
    await body(dir);
  } finally {
    rmTemp(dir);
  }
}

it("finds a manifest at the repo root", () =>
  inTempDir(["Cargo.lock"], async (dir) => {
    assert.equal(await hasOsvManifest(dir), true);
  }));

it("finds a Rust lockfile in a subproject such as src-tauri", () =>
  inTempDir(["package.json", "src-tauri/Cargo.lock"], async (dir) => {
    assert.equal(await hasOsvManifest(dir), true);
  }));

it("finds a go.mod two levels down", () =>
  inTempDir(["services/api/go.mod"], async (dir) => {
    assert.equal(await hasOsvManifest(dir), true);
  }));

it("ignores manifests inside node_modules, target and .git", () =>
  inTempDir(
    ["node_modules/x/Cargo.lock", "target/debug/Cargo.lock", ".git/Cargo.lock"],
    async (dir) => {
      assert.equal(await hasOsvManifest(dir), false);
    },
  ));

it("returns false when no ecosystem manifest exists", () =>
  inTempDir(["package.json", "src/index.ts"], async (dir) => {
    assert.equal(await hasOsvManifest(dir), false);
  }));
