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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installHooks } from "./hooks.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const SKIP_WINDOWS =
  process.platform === "win32"
    ? "POSIX sh hooks and a colon-separated PATH: the hook is not verified on Windows"
    : false;

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

describe("the post-checkout hook", { skip: SKIP_WINDOWS }, () => {
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

describe("the committed .githooks/post-checkout of this repository", { skip: SKIP_WINDOWS }, () => {
  const COMMITTED = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    ".githooks",
    "post-checkout",
  );

  function sandbox(): { root: string; env: NodeJS.ProcessEnv; log: string } {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-committed-hook-")));
    const stubs = join(root, "stubs");
    const home = join(root, "home");
    mkdirSync(stubs);
    mkdirSync(home);
    const log = join(root, "kit-calls.log");
    writeFileSync(join(stubs, "kit"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
    chmodSync(join(stubs, "kit"), 0o755);
    const env = { ...process.env, HOME: home, PATH: `${stubs}:/usr/bin:/bin` };
    return { root, env, log };
  }

  it("is an executable file that names the command", () => {
    const text = readFileSync(COMMITTED, "utf8");
    assert.match(text, /^#!\/bin\/sh/);
    assert.ok(text.includes("kit worktree-gates"));
    assert.equal(text.includes("Generated by kit"), false, "kit must not rewrite a committed hook");
    assert.ok((statSync(COMMITTED).mode & 0o111) !== 0, "the hook must be executable");
  });

  it("runs kit for a new worktree, and for no other checkout", () => {
    const s = sandbox();
    try {
      spawnSync("sh", [COMMITTED, ZEROS40, "def456", "1"], { env: s.env });
      spawnSync("sh", [COMMITTED, ZEROS64, "def456", "1"], { env: s.env });
      spawnSync("sh", [COMMITTED, "abc123", "def456", "1"], { env: s.env });
      spawnSync("sh", [COMMITTED], { env: s.env });
      assert.deepEqual(readFileSync(s.log, "utf8").trim().split("\n"), [
        "worktree-gates",
        "worktree-gates",
      ]);
    } finally {
      rmTemp(s.root);
    }
  });

  it("prefers the self-healing wrapper in the home folder when it exists", () => {
    const s = sandbox();
    try {
      const bin = join(s.env.HOME as string, ".kit", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "kit"), `#!/bin/sh\necho "wrapper $*" >> "${s.log}"\n`);
      chmodSync(join(bin, "kit"), 0o755);
      spawnSync("sh", [COMMITTED, ZEROS40, "def456", "1"], { env: s.env });
      assert.equal(readFileSync(s.log, "utf8").trim(), "wrapper worktree-gates");
    } finally {
      rmTemp(s.root);
    }
  });

  it("exits quietly and successfully when kit is not installed", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-committed-hook-nokit-")));
    try {
      const run = spawnSync("sh", [COMMITTED, ZEROS40, "def456", "1"], {
        env: { HOME: root, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      });
      assert.equal(run.status, 0);
      assert.equal(`${run.stdout}${run.stderr}`, "");
    } finally {
      rmTemp(root);
    }
  });
});
