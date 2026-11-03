/**
 * A new worktree starts without the PreToolUse gates, because they live in the ignored,
 * per-checkout `.claude/` (the marker and `settings.local.json`). On a machine whose main checkout
 * is gated, an agent working in the new worktree then ran ungated. These tests use real git
 * repositories and real linked worktrees.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gateLiveness,
  installEnvWriteGate,
  installInstallGate,
  markGatesInstalled,
} from "./agent-config.js";
import { ensureWorktreeGates } from "./worktree-gates.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** The same install the real code does for one checkout, without writing the wrapper into the home folder. */
async function installGates(cwd: string): Promise<void> {
  await installInstallGate(cwd);
  await installEnvWriteGate(cwd);
}

interface Repo {
  root: string;
  main: string;
  wt: string;
}

function repo(gatedMain: boolean): Repo {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-wt-gates-")));
  const main = join(root, "main");
  const wt = join(root, "wt");
  execFileSync("git", ["init", "-q", main]);
  mkdirSync(join(main, ".claude"), { recursive: true });
  writeFileSync(join(main, "CLAUDE.md"), "# project\n");
  writeFileSync(join(main, ".gitignore"), ".claude/\n");
  git(main, "add", "CLAUDE.md", ".gitignore");
  git(main, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "init");
  if (gatedMain) {
    markGatesInstalled(main);
  }
  git(main, "worktree", "add", "-q", wt);
  return { root, main, wt };
}

describe("ensureWorktreeGates", () => {
  it("wires the gates in a new worktree of a gated checkout", async () => {
    const r = repo(true);
    try {
      await installGates(r.main);
      assert.equal(gateLiveness(r.wt).installGate, false, "the new worktree starts without gates");
      const got = await ensureWorktreeGates(r.wt, installGates);
      assert.equal(got.outcome, "installed");
      const live = gateLiveness(r.wt);
      assert.equal(live.installGate, true);
      assert.equal(live.envGate, true);
      assert.equal(live.everInstalled, true);
    } finally {
      rmTemp(r.root);
    }
  });

  it("leaves tracked files alone in the new worktree", async () => {
    const r = repo(true);
    try {
      await installGates(r.main);
      await ensureWorktreeGates(r.wt, installGates);
      assert.equal(git(r.wt, "status", "--short").trim(), "");
    } finally {
      rmTemp(r.root);
    }
  });

  it("does nothing in the main checkout itself", async () => {
    const r = repo(true);
    try {
      const got = await ensureWorktreeGates(r.main, installGates);
      assert.equal(got.outcome, "not-a-worktree");
    } finally {
      rmTemp(r.root);
    }
  });

  it("does nothing when the main checkout was never gated", async () => {
    const r = repo(false);
    try {
      const got = await ensureWorktreeGates(r.wt, installGates);
      assert.equal(got.outcome, "main-not-gated");
      assert.equal(existsSync(join(r.wt, ".claude", ".kit-gates-installed")), false);
    } finally {
      rmTemp(r.root);
    }
  });

  it("is idempotent: a second run finds the worktree already gated", async () => {
    const r = repo(true);
    try {
      await installGates(r.main);
      await ensureWorktreeGates(r.wt, installGates);
      let installs = 0;
      const got = await ensureWorktreeGates(r.wt, async (cwd) => {
        installs++;
        await installGates(cwd);
      });
      assert.equal(got.outcome, "already-gated");
      assert.equal(installs, 0);
    } finally {
      rmTemp(r.root);
    }
  });

  it("reports a failed install instead of throwing, and does not claim the gates are wired", async () => {
    const r = repo(true);
    try {
      await installGates(r.main);
      const got = await ensureWorktreeGates(r.wt, async () => {
        throw new Error("disk full");
      });
      assert.equal(got.outcome, "failed");
      assert.match(got.detail, /disk full/);
      assert.equal(gateLiveness(r.wt).installGate, false);
    } finally {
      rmTemp(r.root);
    }
  });

  it("reports failed when the installer ran but the gates are still not wired", async () => {
    const r = repo(true);
    try {
      await installGates(r.main);
      const got = await ensureWorktreeGates(r.wt, async () => {});
      assert.equal(got.outcome, "failed");
      assert.match(got.detail, /not wired/);
    } finally {
      rmTemp(r.root);
    }
  });
});
