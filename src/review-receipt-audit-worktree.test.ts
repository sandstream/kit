import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
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
  const dir = mkdtempSync(join(tmpdir(), "kit-review-audit-worktree-"));
  const root = join(dir, "repo");
  try {
    mkdirSync(root);
    git("git", ["init", "-q"], root);
    git("git", ["config", "core.hooksPath", join(dir, "no-hooks")], root);
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

it("preserves an untracked audit log and still rejects another untracked file", () => {
  fixture((root) => {
    const audit = join(root, ".kit-audit.jsonl");
    writeFileSync(audit, "audit evidence\n");
    assert.doesNotThrow(() => cleanReviewWorktree(root, git));
    assert.equal(readFileSync(audit, "utf8"), "audit evidence\n");
    writeFileSync(join(root, "other.txt"), "user data");
    assert.throws(() => cleanReviewWorktree(root, git), /clean worktree/);
    assert.equal(readFileSync(audit, "utf8"), "audit evidence\n");
  });
});

for (const directory of [false, true]) {
  it(`rejects tracked case-colliding audit ${directory ? "directory contents" : "file"}`, () => {
    fixture((root) => {
      const path = join(root, ".KIT-AUDIT.JSONL");
      if (directory) mkdirSync(path);
      const tracked = directory ? join(path, "child") : path;
      writeFileSync(tracked, "tracked data");
      git("git", ["add", ".KIT-AUDIT.JSONL"], root);
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
          "-qm",
          "track audit",
        ],
        root,
      );
      assert.throws(() => cleanReviewWorktree(root, git), /must not contain tracked files/);
      assert.equal(readFileSync(tracked, "utf8"), "tracked data");
    });
  });
}

it("rejects an untracked directory at the audit path", () => {
  fixture((root) => {
    mkdirSync(join(root, ".kit-audit.jsonl"));
    writeFileSync(join(root, ".kit-audit.jsonl", "child"), "preserve");
    assert.throws(() => cleanReviewWorktree(root, git), /clean worktree/);
    assert.equal(readFileSync(join(root, ".kit-audit.jsonl", "child"), "utf8"), "preserve");
  });
});

for (const kind of ["symbolic", "hard"] as const) {
  it(`rejects an untracked ${kind} link at the audit path`, (t) => {
    fixture((root, dir) => {
      const target = join(dir, "target");
      writeFileSync(target, "preserve");
      try {
        if (kind === "symbolic") symlinkSync(target, join(root, ".kit-audit.jsonl"));
        else linkSync(target, join(root, ".kit-audit.jsonl"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (["EPERM", "EACCES", "ENOTSUP"].includes(code)) {
          t.skip("The test file system cannot create this link");
          return;
        }
        throw error;
      }
      assert.throws(() => cleanReviewWorktree(root, git), /regular file without hard links/);
      assert.equal(readFileSync(target, "utf8"), "preserve");
    });
  });
}
