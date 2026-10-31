import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { defectToml, plantedRange, plantFromFix, PlantRefused } from "./plant.js";
import { parseManifest } from "./manifest.js";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { historyRepo } from "./plant.test-support.js";

describe("plantedRange", () => {
  it("reads the file and the new-side range across hunks", () => {
    const patch =
      "--- a/x.ts\n+++ b/x.ts\n@@ -3,2 +3,2 @@\n-a\n+b\n@@ -20 +20,3 @@\n-c\n+d\n+e\n+f\n";
    assert.deepEqual(plantedRange(patch), { file: "x.ts", line_start: 3, line_end: 22 });
  });

  it("refuses a patch touching two files or none", () => {
    assert.throws(() => plantedRange("+++ b/a\n@@ -1 +1 @@\n+++ b/b\n@@ -1 +1 @@\n"), PlantRefused);
    assert.throws(() => plantedRange("+++ b/a\n"), /no hunks/);
  });
});

describe("plantFromFix", () => {
  it("reverses a fix onto a later pinned commit, in the pinned file's line numbers", () => {
    const { dir, fix, pinned } = historyRepo();
    try {
      const planted = plantFromFix(dir, pinned, fix);
      assert.equal(planted.file, "auth.ts");
      assert.deepEqual([planted.line_start <= 12, planted.line_end >= 12], [true, true]);
      assert.match(planted.patch, /^-if \(token && verify\(token\)\) allow\(\);$/m);
      assert.match(planted.patch, /^\+if \(token\) allow\(\);$/m);
      assert.equal(
        execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }),
        "",
      );
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses a reverse that does not apply, a multi-file fix, and a non-commit", () => {
    const { dir, fix, pinned, twoFile } = historyRepo();
    try {
      assert.throws(() => plantFromFix(dir, twoFile, fix), /does not apply cleanly/);
      assert.throws(
        () => plantFromFix(dir, pinned, twoFile),
        /does not apply cleanly|touches 2 files/,
      );
      assert.throws(() => plantFromFix(dir, pinned, "deadbeef"), /is not a commit/);
      assert.throws(() => plantFromFix(dir, pinned, "HEAD; rm -rf /"), /must be a hex commit id/);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("defectToml", () => {
  it("emits a [[defect]] block the manifest parser accepts", () => {
    const block = defectToml(
      { file: "auth.ts", line_start: 12, line_end: 12 },
      { id: "fix-1", split: "holdout", patchPath: "defects/fix-1.diff" },
    );
    const m = parseManifest(
      `[input]\nrepo = "r"\ncommit = "${"a".repeat(40)}"\nprompt = "p.md"\n\n${block}`,
    );
    assert.deepEqual(m.defects[0], {
      id: "fix-1",
      file: "auth.ts",
      line_start: 12,
      line_end: 12,
      kind: "reverted-fix",
      split: "holdout",
      patch: "defects/fix-1.diff",
    });
  });
});
