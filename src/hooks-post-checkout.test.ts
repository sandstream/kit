/**
 * The post-checkout hook that installs the gates in a new worktree. git runs it after every
 * checkout, so it must leave at once, print nothing and not start kit unless the checkout is a new
 * worktree (its previous HEAD is all zeros). These tests install the hook into a real repository and
 * let git run it, with a stub `kit` on PATH that records where and how it was called.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installHooks } from "./hooks.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const COMMAND = "kit worktree-gates";
const ZEROS40 = "0".repeat(40);
const ZEROS64 = "0".repeat(64);

interface Setup {
  root: string;
  main: string;
  hook: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

async function setup(): Promise<Setup> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-post-checkout-")));
  const main = join(root, "main");
  const stubs = join(root, "stubs");
  const home = join(root, "home");
  mkdirSync(stubs);
  mkdirSync(home);
  const log = join(root, "kit-calls.log");
  writeFileSync(
    join(stubs, "kit"),
    `#!/bin/sh\necho "$(pwd) $*" >> "${log}"\nexit "\${KIT_STUB_EXIT:-0}"\n`,
  );
  chmodSync(join(stubs, "kit"), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${stubs}:${process.env.PATH}`,
  };
  execFileSync("git", ["init", "-q", main]);
  writeFileSync(join(main, "a.txt"), "a\n");
  execFileSync("git", ["-C", main, "add", "a.txt"]);
  execFileSync("git", [
    "-C",
    main,
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "a",
  ]);
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    await installHooks({ "post-checkout": [COMMAND] }, join(main, ".git"), main);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
  return { root, main, hook: join(main, ".git", "hooks", "post-checkout"), log, env };
}

const calls = (s: Setup): string[] =>
  existsSync(s.log) ? readFileSync(s.log, "utf8").trim().split("\n") : [];

describe("the post-checkout hook", () => {
  it("is written as an executable hook that names the command", async () => {
    const s = await setup();
    try {
      const text = readFileSync(s.hook, "utf8");
      assert.match(text, /^#!\/bin\/sh/);
      assert.ok(text.includes(COMMAND));
    } finally {
      rmTemp(s.root);
    }
  });

  it("runs kit in the new worktree when git creates one", async () => {
    const s = await setup();
    try {
      const wt = join(s.root, "wt");
      execFileSync("git", ["-C", s.main, "worktree", "add", "-q", wt], { env: s.env });
      assert.deepEqual(calls(s), [`${wt} worktree-gates`]);
    } finally {
      rmTemp(s.root);
    }
  });

  it("does not start kit, and prints nothing, on an ordinary checkout", async () => {
    const s = await setup();
    try {
      execFileSync("git", ["-C", s.main, "checkout", "-q", "-b", "other"], { env: s.env });
      execFileSync("git", ["-C", s.main, "checkout", "-q", "-"], { env: s.env });
      assert.deepEqual(calls(s), []);
      const run = spawnSync("sh", [s.hook, "abc123", "def456", "1"], {
        env: s.env,
        encoding: "utf8",
      });
      assert.equal(run.status, 0);
      assert.equal(`${run.stdout}${run.stderr}`, "");
    } finally {
      rmTemp(s.root);
    }
  });

  it("runs for an all-zero previous HEAD of either hash length, and not when it is empty", async () => {
    const s = await setup();
    try {
      for (const zeros of [ZEROS40, ZEROS64]) {
        spawnSync("sh", [s.hook, zeros, "def456", "1"], { env: s.env });
      }
      spawnSync("sh", [s.hook], { env: s.env });
      assert.equal(calls(s).length, 2);
    } finally {
      rmTemp(s.root);
    }
  });

  it("never fails the checkout, whatever kit does", async () => {
    const s = await setup();
    try {
      const wt = join(s.root, "wt");
      execFileSync("git", ["-C", s.main, "worktree", "add", "-q", wt], {
        env: { ...s.env, KIT_STUB_EXIT: "7" },
      });
      assert.equal(existsSync(join(wt, "a.txt")), true);
    } finally {
      rmTemp(s.root);
    }
  });
});
