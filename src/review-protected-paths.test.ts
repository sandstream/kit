import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyProtectedPaths,
  DEFAULT_PROTECTED_PATH_RULES,
  loadProtectedPathRules,
} from "./review-protected-paths.js";

it("keeps the built-in defaults aligned with the shipped rule file", () => {
  assert.deepEqual(DEFAULT_PROTECTED_PATH_RULES, loadProtectedPathRules(process.cwd()));
});

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

it("protects the secrets and policy command surfaces", () => {
  const rules = loadProtectedPathRules(process.cwd());
  const gaps = [
    "src/commands/secrets.ts",
    "src/commands/secrets-onecli-keyname.test.ts",
    "src/commands/policy.ts",
    "src/commands/policy-approve.test.ts",
    "src/check-secrets-infisical.test.ts",
    "src/check-policy-ops.ts",
  ];
  const unprotected = gaps.filter((path) => classifyProtectedPaths([path], rules).length === 0);
  assert.deepEqual(unprotected, []);
});

it("protects the review gate's own decision code, not only the workflow that runs it", () => {
  // kit-research claude-code-review-at-anthropic-vs-kit: #762 changed the gate's decision code and
  // the gate approved it without a person, because only `.github/` was protected.
  const rules = loadProtectedPathRules(process.cwd());
  const gateCode = [
    "scripts/agent-review-gate.mjs",
    "scripts/agent-model-review.mjs",
    "scripts/github-app-token.mjs",
    "src/review-protected-paths.ts",
    "src/review-protected-paths-github.ts",
  ];
  const unprotected = gateCode.filter((path) => classifyProtectedPaths([path], rules).length === 0);
  assert.deepEqual(unprotected, []);
  assert.deepEqual(classifyProtectedPaths(["scripts/other.mjs"], rules), []);
});
