import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildScanIncompleteError, scanBuildArtifacts } from "./scan-build.js";
import { MAX_BYTES } from "./scan-build-sourcemap.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-scan-coverage-"));
  mkdirSync(join(dir, "build"), { recursive: true });
  return dir;
}

async function incompleteDetails(dir: string): Promise<string[]> {
  try {
    await scanBuildArtifacts(dir);
  } catch (error) {
    assert.ok(error instanceof BuildScanIncompleteError);
    return error.issues.map((issue) => issue.detail);
  }
  return [];
}

describe("scanBuildArtifacts reports what it could not cover", () => {
  it("reports an oversized script that is not a source map", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "build", "big.js"), "x".repeat(MAX_BYTES + 1));
      const details = await incompleteDetails(dir);
      assert.ok(details.some((d) => d.includes("build/big.js") && d.includes("exceeds")));
    } finally {
      rmTemp(dir);
    }
  });

  it("reports a directory nested deeper than the walk limit", async () => {
    const dir = makeRepo();
    try {
      const deep = join(dir, "build", "a", "b", "c", "d", "e", "f", "g", "h", "i");
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(deep, "late.js"), "const x = 1;");
      const details = await incompleteDetails(dir);
      assert.ok(details.some((d) => d.includes("deeper")));
    } finally {
      rmTemp(dir);
    }
  });

  it(
    "reports a script and a directory it cannot read",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    async () => {
      const dir = makeRepo();
      const locked = join(dir, "build", "locked");
      try {
        writeFileSync(join(dir, "build", "hidden.js"), "const x = 1;");
        chmodSync(join(dir, "build", "hidden.js"), 0o000);
        mkdirSync(locked);
        chmodSync(locked, 0o000);
        const details = await incompleteDetails(dir);
        assert.ok(details.some((d) => d.includes("build/hidden.js")));
        assert.ok(details.some((d) => d.includes("build/locked")));
      } finally {
        chmodSync(locked, 0o700);
        rmTemp(dir);
      }
    },
  );

  it("stays quiet for a small, readable build", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "build", "ok.js"), "const x = 1;");
      assert.deepEqual(await scanBuildArtifacts(dir), []);
    } finally {
      rmTemp(dir);
    }
  });
});
