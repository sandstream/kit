/**
 * `kit worktree-gates` through the real CLI, in a real linked worktree. HOME is a
 * temporary folder so the self-healing wrapper the gates embed is not written into the real one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gateLiveness, markGatesInstalled } from "../agent-config.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function run(cwd: string, home: string) {
  const r = spawnSync(process.execPath, [CLI, "worktree-gates"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, KIT_NO_UPDATE_CHECK: "1" },
    timeout: 60_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("kit worktree-gates", () => {
  it("gates a new worktree of a gated checkout, quietly, and is silent when nothing is to do", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-wt-gates-cli-")));
    try {
      const main = join(root, "main");
      const wt = join(root, "wt");
      const home = join(root, "home");
      mkdirSync(home);
      execFileSync("git", ["init", "-q", main]);
      mkdirSync(join(main, ".claude"), { recursive: true });
      writeFileSync(join(main, "CLAUDE.md"), "# project\n");
      writeFileSync(join(main, ".gitignore"), ".claude/\n");
      git(main, "add", "CLAUDE.md", ".gitignore");
      git(main, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "init");
      markGatesInstalled(main);
      git(main, "worktree", "add", "-q", wt);

      assert.equal(gateLiveness(wt).installGate, false);
      const first = run(wt, home);
      assert.equal(first.status, 0, first.out);
      assert.match(first.out, /kit: worktree gates: the gates of .* are now wired here/);
      const live = gateLiveness(wt);
      assert.equal(live.installGate, true);
      assert.equal(live.envGate, true);
      // The git hook belongs to the shared repository. Installing the gates in a worktree must not
      // also write it: in a repository with a relative core.hooksPath that is a new untracked file.
      assert.equal(existsSync(join(main, ".git", "hooks", "post-checkout")), false);
      assert.equal(git(wt, "status", "--short").trim(), "");

      const second = run(wt, home);
      assert.equal(second.status, 0, second.out);
      assert.doesNotMatch(second.out, /worktree gates/);
      const inMain = run(main, home);
      assert.equal(inMain.status, 0, inMain.out);
      assert.doesNotMatch(inMain.out, /worktree gates/);
    } finally {
      rmTemp(root);
    }
  });
});
