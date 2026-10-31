import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProtectedPaths, loadProtectedPathRules } from "./review-protected-paths.js";

it("names each protected class from the repository rule file", () => {
  const rules = loadProtectedPathRules(process.cwd());
  const paths = classifyProtectedPaths(
    [
      "docs/RELEASING.md",
      ".github/workflows/ci.yml",
      "src/secrets-rotate.ts",
      "src/read-only-surface.ts",
      "src/ordinary.ts",
    ],
    rules,
  );
  assert.deepEqual(paths, [
    { path: "docs/RELEASING.md", classes: ["release"] },
    { path: ".github/workflows/ci.yml", classes: ["github"] },
    { path: "src/secrets-rotate.ts", classes: ["secrets"] },
    { path: "src/read-only-surface.ts", classes: ["permissions"] },
  ]);
});

it("uses the shipped rules when a project has no rule file", () => {
  const root = mkdtempSync(join(tmpdir(), "kit-review-rules-"));
  try {
    const rules = loadProtectedPathRules(root);
    assert.deepEqual(classifyProtectedPaths([".github/workflows/ci.yml"], rules), [
      { path: ".github/workflows/ci.yml", classes: ["github"] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
