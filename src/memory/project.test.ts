import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCurrentProjectRoot,
  getProjectRecallRoots,
  resolveLocalProjectPath,
} from "./project.js";

it("keeps non-repositories and explicit subdirectory scopes local", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-project-")));
  try {
    assert.equal(getCurrentProjectRoot(root), root);
    assert.deepEqual(getProjectRecallRoots(root), [root]);
    assert.deepEqual(getProjectRecallRoots(join(root, "missing")), [join(root, "missing")]);
    execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
    const subdir = join(root, "src");
    mkdirSync(subdir);
    assert.equal(getCurrentProjectRoot(subdir), root);
    assert.deepEqual(getProjectRecallRoots(subdir), [subdir]);
    assert.deepEqual(getProjectRecallRoots(root), [root]);
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
    assert.deepEqual(getProjectRecallRoots(alias), [alias, real]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
