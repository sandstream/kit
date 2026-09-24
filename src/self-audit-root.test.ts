import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveKitRoot } from "./self-audit-root.js";

const roots: string[] = [];

function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), "kit-audit-root-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

it("finds the nearest kit root despite unrelated or malformed nested manifests", () => {
  const root = tempTree();
  writeFileSync(join(root, "package.json"), '{"name":"sandstream-kit"}');
  const child = join(root, "nested", "deeper");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(root, "nested", "package.json"), "{bad json");
  assert.equal(resolveKitRoot(child), root);
  writeFileSync(join(root, "nested", "package.json"), '{"name":"sandstream-kit"}');
  assert.equal(resolveKitRoot(child), join(root, "nested"));
});

it("returns null after reaching filesystem root without a kit package", () => {
  const root = tempTree();
  assert.equal(resolveKitRoot(root), null);
});
