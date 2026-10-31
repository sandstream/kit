import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { cleanReviewWorktree, REVIEW_RECEIPT_FILE } from "./review-receipt-worktree.js";

function fixture(): { dir: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), "kit-review-worktree-"));
  const root = join(dir, "repo");
  mkdirSync(root);
  git("git", ["init", "-q"], root);
  git("git", ["config", "user.email", "test@example.test"], root);
  git("git", ["config", "user.name", "Test"], root);
  git("git", ["config", "core.hooksPath", join(dir, "no-hooks")], root);
  writeFileSync(join(root, "tracked.txt"), "original\n");
  git("git", ["add", "tracked.txt"], root);
  git("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "initial"], root);
  return { dir, root };
}

function git(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" });
}

describe("review receipt worktree validation", () => {
  it("allows its own untracked receipts but rejects unrelated files and tracked edits", () => {
    const { dir, root } = fixture();
    try {
      writeFileSync(join(root, REVIEW_RECEIPT_FILE), "receipt");
      writeFileSync(join(root, ".kit-review-receipt-history.jsonl"), "history");
      assert.doesNotThrow(() => cleanReviewWorktree(root, git));
      writeFileSync(join(root, "other.txt"), "untracked");
      assert.throws(() => cleanReviewWorktree(root, git), /clean worktree/);
      git("git", ["add", "other.txt"], root);
      git("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "add other"], root);
      writeFileSync(join(root, "tracked.txt"), "modified\n");
      assert.throws(() => cleanReviewWorktree(root, git), /clean worktree/);
      assert.equal(readFileSync(join(root, REVIEW_RECEIPT_FILE), "utf8"), "receipt");
    } finally {
      rmTemp(dir);
    }
  });

  it("rejects a tracked receipt with different letter case without changing it", () => {
    const { dir, root } = fixture();
    const path = join(root, ".KIT-REVIEW-RECEIPT.JSON");
    try {
      writeFileSync(path, "tracked receipt");
      git("git", ["add", ".KIT-REVIEW-RECEIPT.JSON"], root);
      git("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "track receipt"], root);
      assert.throws(() => cleanReviewWorktree(root, git), /must not contain tracked files/);
      assert.equal(readFileSync(path, "utf8"), "tracked receipt");
    } finally {
      rmTemp(dir);
    }
  });

  it("rejects a tracked file beneath a receipt path", () => {
    const { dir, root } = fixture();
    try {
      mkdirSync(join(root, ".kit-review-receipt-history.jsonl"));
      const child = join(root, ".kit-review-receipt-history.jsonl", "tracked.txt");
      writeFileSync(child, "preserve");
      git("git", ["add", ".kit-review-receipt-history.jsonl/tracked.txt"], root);
      git("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "track child"], root);
      assert.throws(() => cleanReviewWorktree(root, git), /must not contain tracked files/);
      assert.equal(readFileSync(child, "utf8"), "preserve");
    } finally {
      rmTemp(dir);
    }
  });

  it("rejects an untracked receipt symlink without modifying its target", (t) => {
    const { dir, root } = fixture();
    const target = join(dir, "target");
    try {
      writeFileSync(target, "unchanged");
      try {
        symlinkSync(target, join(root, REVIEW_RECEIPT_FILE));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
          t.skip("Windows does not permit symlink creation");
          return;
        }
        throw error;
      }
      assert.throws(() => cleanReviewWorktree(root, git), /regular file/);
      assert.equal(readFileSync(target, "utf8"), "unchanged");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("review worktree safety failures", () => {
  it("rejects a hard-linked history file without modifying its target", (t) => {
    const { dir, root } = fixture();
    const target = join(root, "tracked.txt");
    try {
      try {
        linkSync(target, join(root, ".kit-review-receipt-history.jsonl"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) {
          t.skip("The test file system does not permit hard links");
          return;
        }
        throw error;
      }
      assert.throws(() => cleanReviewWorktree(root, git), /hard links/);
      assert.equal(readFileSync(target, "utf8"), "original\n");
    } finally {
      rmTemp(dir);
    }
  });

  it("refuses validation if Git cannot report worktree status", () => {
    const { dir, root } = fixture();
    try {
      const unavailableStatus = (command: string, args: string[], cwd: string): string => {
        if (args[0] === "status") throw new Error("status unavailable");
        return git(command, args, cwd);
      };
      assert.throws(() => cleanReviewWorktree(root, unavailableStatus), /status unavailable/);
    } finally {
      rmTemp(dir);
    }
  });
});
