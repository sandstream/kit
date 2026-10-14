import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";

const root = process.cwd();

function readLock(): { tools: Record<string, { source: string; sourceDetail?: string }> } {
  return JSON.parse(readFileSync(join(root, ".kit", "cli-lock.json"), "utf-8"));
}

function declaredTools(): string[] {
  const toml = parse(readFileSync(join(root, ".kit.toml"), "utf-8")) as {
    tools?: Record<string, unknown>;
  };
  return Object.keys(toml.tools ?? {});
}

describe("committed .kit/cli-lock.json matches .kit.toml (STD-08)", () => {
  it("records no machine-local provenance", () => {
    const local = Object.entries(readLock().tools)
      .filter(([, t]) => t.source === "manual" || t.sourceDetail === "kit-shim")
      .map(([name]) => name);
    assert.deepEqual(local, [], `machine-local entries in a committed lock: ${local.join(", ")}`);
  });

  it("locks only tools that .kit.toml declares", () => {
    const declared = new Set(declaredTools());
    const extra = Object.keys(readLock().tools).filter((name) => !declared.has(name));
    assert.deepEqual(extra, [], `locked but not declared: ${extra.join(", ")}`);
  });

  it("declares no package manager the repo has no lockfile for", () => {
    const hasPnpmLock = (() => {
      try {
        readFileSync(join(root, "pnpm-lock.yaml"));
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasPnpmLock) {
      assert.ok(!declaredTools().includes("pnpm"), "pnpm declared but the repo uses npm");
    }
  });
});
