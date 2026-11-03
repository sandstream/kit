/**
 * The whole path, with nothing stubbed: `kit agent-config` in a main checkout installs the gates and
 * the post-checkout hook, then `git worktree add` runs that hook, which runs the built kit, which
 * gates the new worktree before any session starts in it. HOME is a temporary folder, so the
 * self-healing wrapper the hook embeds is not written into the real one.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { gateLiveness } from "./agent-config.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

function project(root: string): string {
  const main = join(root, "main");
  execFileSync("git", ["init", "-q", main]);
  writeFileSync(join(main, "CLAUDE.md"), "# project\n");
  writeFileSync(join(main, ".gitignore"), ".claude/\n");
  execFileSync("git", ["-C", main, "add", "CLAUDE.md", ".gitignore"]);
  execFileSync("git", [
    "-C",
    main,
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init",
  ]);
  return main;
}

describe("kit agent-config, then git worktree add", () => {
  it("gates the new worktree with no further step", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-wt-e2e-")));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const main = project(root);
      const env = { ...process.env, HOME: home, USERPROFILE: home, KIT_NO_UPDATE_CHECK: "1" };
      const setup = spawnSync(process.execPath, [CLI, "agent-config"], {
        cwd: main,
        env,
        encoding: "utf8",
        timeout: 120_000,
      });
      assert.equal(setup.status, 0, `${setup.stdout}${setup.stderr}`);
      assert.equal(gateLiveness(main).installGate, true, "the main checkout is gated");
      assert.equal(existsSync(join(main, ".git", "hooks", "post-checkout")), true);

      const wt = join(root, "wt");
      execFileSync("git", ["-C", main, "worktree", "add", "-q", wt], { env, timeout: 120_000 });
      const live = gateLiveness(wt);
      assert.equal(live.installGate, true, "the new worktree has the install gate");
      assert.equal(live.envGate, true, "the new worktree has the env-write gate");
    } finally {
      rmTemp(root);
    }
  });
});
