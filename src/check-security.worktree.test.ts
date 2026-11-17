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
      // git reports long, forward-slash paths; os.tmpdir() on Windows can be an 8.3 short
      // path. Assert the shape and the main checkout's own directory name, not one spelling.
      assert.match(
        res.detail,
        /^this is a linked git worktree of .*main: the gates are installed there/,
      );
      assert.match(res.detail, /Run: kit agent-config/);
    } finally {
      r.cleanup();
    }
  });

  it("still skips a worktree of a repository that was never gated", async () => {
    const r = repoWithWorktree(false);
    try {
      const res = await checkGateLiveness(r.task, {});
      assert.strictEqual(res.status, "skip");
      assert.strictEqual(res.detail, "enforcement gates not installed in this checkout");
    } finally {
      r.cleanup();
    }
  });
});

// Measured before this block: a Claude Code cloud session (CLAUDECODE=1) in a fresh clone of a
// kit-managed repo ran every tool call ungated, and the row said "skip". The env is injected so
// the verdict does not depend on whichever shell runs the tests.
describe("gate liveness in an agent session", () => {
  function freshClone(kitManaged: boolean) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kit-session-")));
    git(dir, "init", "-q");
    if (kitManaged) writeFileSync(join(dir, ".kit.toml"), "");
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("fails a never-gated kit-managed checkout under Claude Code and names the fix", async () => {
    const r = freshClone(true);
    try {
      const res = await checkGateLiveness(r.dir, { CLAUDECODE: "1" });
      assert.strictEqual(res.status, "fail");
      assert.strictEqual(res.severity, "high");
      assert.match(
        res.detail,
        /^a Claude Code session is running .* runs ungated\. Run: kit agent-config$/,
      );
    } finally {
      r.cleanup();
    }
  });

  it("names Codex when Codex is the session", async () => {
    const r = freshClone(true);
    try {
      const res = await checkGateLiveness(r.dir, { CODEX_THREAD_ID: "t-1" });
      assert.strictEqual(res.status, "fail");
      assert.match(res.detail, /^a Codex session/);
    } finally {
      r.cleanup();
    }
  });

  it("still skips outside an agent session, and without .kit.toml", async () => {
    const managed = freshClone(true);
    const plain = freshClone(false);
    try {
      const outside = await checkGateLiveness(managed.dir, {});
      assert.strictEqual(outside.status, "skip");
      assert.strictEqual(outside.detail, "enforcement gates not installed in this checkout");
      const unmanaged = await checkGateLiveness(plain.dir, { CLAUDECODE: "1" });
      assert.strictEqual(unmanaged.status, "skip");
    } finally {
      managed.cleanup();
      plain.cleanup();
    }
  });
});
