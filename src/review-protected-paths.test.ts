import { it } from "node:test";
import assert from "node:assert/strict";
import { classifyProtectedPaths, loadProtectedPathRules } from "./review-protected-paths.js";

it("names each protected class from the repository rule file", () => {
  const rules = loadProtectedPathRules(process.cwd());
  const paths = classifyProtectedPaths([
    "docs/RELEASING.md",
    ".github/workflows/ci.yml",
    "src/secrets-rotate.ts",
    "src/read-only-surface.ts",
    "src/ordinary.ts",
  ], rules);
  assert.deepEqual(paths, [
    { path: "docs/RELEASING.md", classes: ["release"] },
    { path: ".github/workflows/ci.yml", classes: ["github"] },
    { path: "src/secrets-rotate.ts", classes: ["secrets"] },
    { path: "src/read-only-surface.ts", classes: ["permissions"] },
  ]);
});
