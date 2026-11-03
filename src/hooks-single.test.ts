/** installOneHook: a single hook, installed without the bypass detector installHooks always adds. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { installOneHook } from "./hooks-single.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function project(root: string): string {
  const main = join(root, "main");
  execFileSync("git", ["init", "-q", main]);
  writeFileSync(join(main, "a.txt"), "a\n");
  return main;
}

describe("installOneHook", () => {
  it("installs only the named hook, with no bypass detector beside it", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-one-hook-")));
    try {
      const main = project(root);
      const r = await installOneHook("post-checkout", ["kit worktree-gates"], ".git", main);
      assert.equal(r.action, "installed");
      assert.equal(existsSync(join(main, ".git", "hooks", "post-checkout")), true);
      assert.equal(existsSync(join(main, ".git", "hooks", "pre-commit")), false);
      assert.equal(existsSync(join(main, ".git", "hooks", "post-commit")), false);
    } finally {
      rmTemp(root);
    }
  });

  it("does nothing outside a git repository, and creates no .git", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-one-hook-nogit-")));
    try {
      const r = await installOneHook("post-checkout", ["kit x"], ".git", dir);
      assert.equal(r.action, "skipped");
      assert.equal(existsSync(join(dir, ".git")), false);
    } finally {
      rmTemp(dir);
    }
  });

  it("leaves a post-checkout hook that kit did not write untouched", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-one-hook-own-")));
    try {
      const main = project(root);
      const hook = join(main, ".git", "hooks", "post-checkout");
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, "#!/bin/sh\necho mine\n", { mode: 0o755 });
      const r = await installOneHook("post-checkout", ["kit worktree-gates"], ".git", main);
      assert.equal(r.action, "skipped");
      assert.equal(readFileSync(hook, "utf8"), "#!/bin/sh\necho mine\n");
    } finally {
      rmTemp(root);
    }
  });
});
