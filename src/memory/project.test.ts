import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCurrentProjectRoot,
  getProjectRecallRoots,
  recallRootVariants,
  resolveLocalProjectPath,
} from "./project.js";

it("keeps non-repositories and explicit subdirectory scopes local", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-project-")));
  try {
    assert.equal(getCurrentProjectRoot(root), root);
    assert.deepEqual(getProjectRecallRoots(root), recallRootVariants(root));
    assert.deepEqual(
      getProjectRecallRoots(join(root, "missing")),
      recallRootVariants(join(root, "missing")),
    );
    execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
    const subdir = join(root, "src");
    mkdirSync(subdir);
    assert.equal(statSync(getCurrentProjectRoot(subdir)).ino, statSync(root).ino);
    assert.deepEqual(getProjectRecallRoots(subdir), recallRootVariants(subdir));
    assert.ok(getProjectRecallRoots(root).includes(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("resolves symlinked roots and future descendants without losing the original recall alias", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kit-project-alias-")));
  try {
    const real = join(tmp, "real");
    const alias = join(tmp, "alias");
    mkdirSync(real);
    symlinkSync(real, alias, "junction");
    assert.equal(resolveLocalProjectPath(alias), real);
    assert.equal(
      resolveLocalProjectPath(join(alias, "future", "src")),
      join(real, "future", "src"),
    );
    assert.deepEqual(getProjectRecallRoots(alias), [
      ...new Set([alias, real].flatMap(recallRootVariants)),
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

it("expands only repository roots to their registered worktrees", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "kit-project-worktrees-")));
  const root = join(tmp, "repo_%");
  const worktree = join(tmp, "review worktree");
  const unrelated = join(tmp, "repoXother");
  mkdirSync(root);
  mkdirSync(unrelated);
  try {
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", worktree]);
    const subdir = join(root, "src");
    mkdirSync(subdir);
    const same = (candidate: string, path: string) => {
      try {
        const normalize = (value: string) =>
          resolveLocalProjectPath(value).replaceAll("\\", "/").toLowerCase();
        if (normalize(candidate) === normalize(path)) return true;
        const a = statSync(candidate);
        const b = statSync(path);
        return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;
      } catch {
        return false;
      }
    };
    assert.ok(getProjectRecallRoots(root).some((candidate) => same(candidate, worktree)));
    assert.ok(getProjectRecallRoots(worktree).some((candidate) => same(candidate, root)));
    assert.ok(!getProjectRecallRoots(subdir).some((candidate) => same(candidate, worktree)));
    assert.ok(!getProjectRecallRoots(root).some((candidate) => same(candidate, unrelated)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
