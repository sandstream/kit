/** Check the exact governance budget exception with a real Git worktree. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cleanReviewWorktree } from "./review-receipt-worktree.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function git(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

function fixture(test: (root: string, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-budget-worktree-"));
  const root = join(dir, "repo");
  try {
    mkdirSync(root);
    git("git", ["init", "-q"], root);
    git(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-qm",
        "initial",
      ],
      root,
    );
    test(root, dir);
  } finally {
    rmTemp(dir);
  }
}

it("preserves the exact untracked budget file but rejects unrelated files", () => {
  fixture((root) => {
    const path = join(root, ".kit-budget.json");
    writeFileSync(path, "budget evidence\n");
    assert.doesNotThrow(() => cleanReviewWorktree(root, git));
    assert.equal(readFileSync(path, "utf8"), "budget evidence\n");
    writeFileSync(join(root, ".kit-budget.json.bak"), "other");
    assert.throws(() => cleanReviewWorktree(root, git), /clean worktree/);
    assert.equal(readFileSync(path, "utf8"), "budget evidence\n");
  });
});

for (const directory of [false, true]) {
  it(`rejects tracked case-colliding budget ${directory ? "directory contents" : "file"}`, () => {
    fixture((root) => {
      const path = join(root, ".KIT-BUDGET.JSON");
      if (directory) mkdirSync(path);
      const tracked = directory ? join(path, "child") : path;
      writeFileSync(tracked, "tracked data");
      git("git", ["add", ".KIT-BUDGET.JSON"], root);
      assert.throws(() => cleanReviewWorktree(root, git), /must not contain tracked files/);
      assert.equal(readFileSync(tracked, "utf8"), "tracked data");
    });
  });
}

it("rejects an untracked directory at the budget path", () => {
  fixture((root) => {
    const dir = join(root, ".kit-budget.json");
    mkdirSync(dir);
    writeFileSync(join(dir, "child"), "preserve");
    assert.throws(() => cleanReviewWorktree(root, git), /clean worktree/);
    assert.equal(readFileSync(join(dir, "child"), "utf8"), "preserve");
  });
});

for (const kind of ["symbolic", "dangling", "hard"] as const) {
  it(`rejects an untracked ${kind} link at the budget path`, (t) => {
    fixture((root, dir) => {
      const target = join(dir, "target");
      if (kind !== "dangling") writeFileSync(target, "preserve");
      try {
        if (kind === "hard") linkSync(target, join(root, ".kit-budget.json"));
        else symlinkSync(target, join(root, ".kit-budget.json"));
      } catch (error) {
        if (["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          t.skip("The test file system cannot create this link");
          return;
        }
        throw error;
      }
      assert.throws(() => cleanReviewWorktree(root, git), /regular file without hard links/);
      if (kind === "dangling") assert.equal(existsSync(target), false);
      else assert.equal(readFileSync(target, "utf8"), "preserve");
    });
  });
}
