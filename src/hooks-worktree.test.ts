/**
 * In a linked worktree `.git` is a file and git runs the hooks of the shared repository. Before
 * this, resolveHooksDir returned `<worktree>/.git/hooks`, so every declared hook read as "not
 * installed" there and `kit hooks install` could not land (found while wiring #671).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHooksDir } from "./hooks.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

describe("resolveHooksDir in a linked worktree", () => {
  it("returns the shared repository's hooks directory, not <worktree>/.git/hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "kit-hooks-wt-"));
    try {
      const main = join(root, "main");
      const wt = join(root, "wt");
      execFileSync("git", ["init", "-q", main]);
      writeFileSync(join(main, "a.txt"), "a\n");
      git(main, "add", "a.txt");
      git(main, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "a");
      git(main, "worktree", "add", "-q", wt);
      const expected = realpathSync.native(join(main, ".git", "hooks"));
      assert.equal(realpathSync.native(resolveHooksDir(".git", wt)), expected);
      assert.equal(realpathSync.native(resolveHooksDir(".git", main)), expected);
    } finally {
      rmTemp(root);
    }
  });
});
