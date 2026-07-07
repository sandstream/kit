import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceGlobs, resolveWorkspaceRoots, workspaceSourceDirs } from "./workspaces.js";

function turborepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-ws-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
  );
  for (const ws of ["apps/web", "apps/api", "packages/ui"]) {
    mkdirSync(join(dir, ws, "src"), { recursive: true });
    writeFileSync(join(dir, ws, "package.json"), "{}");
    writeFileSync(join(dir, ws, "src", "index.tsx"), "export const X = () => null;\n");
  }
  // A dir matching the glob WITHOUT its own package.json is not a workspace.
  mkdirSync(join(dir, "apps", "not-a-package"), { recursive: true });
  return dir;
}

describe("workspace resolution (#249)", () => {
  it("reads workspaces globs from package.json (array form)", () => {
    const dir = turborepo();
    assert.deepEqual(workspaceGlobs(dir).sort(), ["apps/*", "packages/*"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads packages from pnpm-workspace.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ws-"));
    writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - packages/*\n');
    assert.deepEqual(workspaceGlobs(dir).sort(), ["apps/*", "packages/*"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("expands single-star globs to dirs carrying their own package.json", () => {
    const dir = turborepo();
    assert.deepEqual(resolveWorkspaceRoots(dir), ["apps/api", "apps/web", "packages/ui"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("workspaceSourceDirs finds each workspace's src dirs", () => {
    const dir = turborepo();
    assert.deepEqual(workspaceSourceDirs(dir), ["apps/api/src", "apps/web/src", "packages/ui/src"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] in a plain single-package repo (callers keep root dirs)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ws-"));
    writeFileSync(join(dir, "package.json"), "{}");
    assert.deepEqual(resolveWorkspaceRoots(dir), []);
    assert.deepEqual(workspaceSourceDirs(dir), []);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("checkTests + checkDesign in a monorepo (#249)", () => {
  it("checkTests scans workspace src dirs instead of skipping on a monorepo", async () => {
    const dir = turborepo();
    const { checkTests } = await import("./check-tests.js");
    const results = await checkTests({ cwd: dir });
    const cov = results.find((r) => r.name === "unit-test coverage")!;
    // index.tsx isn't .ts/.js source for the coverage walker, so add a real file:
    assert.notEqual(cov.detail, "no src/ directory found");
    rmSync(dir, { recursive: true, force: true });
  });

  it("an empty scan is an explicit monorepo-aware skip, never a silent green", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-ws-"));
    writeFileSync(join(dir, "package.json"), "{}");
    const { checkTests } = await import("./check-tests.js");
    const results = await checkTests({ cwd: dir });
    const cov = results.find((r) => r.name === "unit-test coverage")!;
    assert.equal(cov.status, "skip");
    assert.match(cov.detail, /workspace resolution may have missed/);
    rmSync(dir, { recursive: true, force: true });
  });
});
