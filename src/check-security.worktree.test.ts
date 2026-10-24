import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGateLiveness } from "./check-security.js";
import { gateMarkerPath } from "./agent-config.js";

// A worktree-per-task harness (T3 Code, Claude Code worktrees) runs the agent in a linked git
// worktree. kit's hooks and its install marker live in the gitignored `.claude/`, so the
// worktree has neither. Measured before this file: liveness answered "skip — enforcement gates
// not installed on this machine" there, on the machine where the gates were installed.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });

function repoWithWorktree(gated: boolean) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kit-wt-")));
  const main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-q");
  writeFileSync(join(main, ".gitignore"), ".claude/\n");
  git(main, "add", "-A");
  git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  if (gated) {
    mkdirSync(join(main, ".claude"));
    writeFileSync(gateMarkerPath(main), "");
  }
  const task = join(base, "task");
  git(main, "worktree", "add", "-q", task, "-b", "task");
  return { main, task, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("gate liveness in a linked git worktree", () => {
  it("fails when the main checkout is gated and the worktree is not", async () => {
    const r = repoWithWorktree(true);
    try {
      const res = await checkGateLiveness(r.task);
      assert.strictEqual(res.status, "fail");
      assert.strictEqual(res.severity, "high");
      assert.ok(res.detail.includes(`linked git worktree of ${r.main}`), res.detail);
      assert.match(res.detail, /Run: kit agent-config/);
    } finally {
      r.cleanup();
    }
  });

  it("still skips a worktree of a repository that was never gated", async () => {
    const r = repoWithWorktree(false);
    try {
      const res = await checkGateLiveness(r.task);
      assert.strictEqual(res.status, "skip");
      assert.strictEqual(res.detail, "enforcement gates not installed in this checkout");
    } finally {
      r.cleanup();
    }
  });
});
