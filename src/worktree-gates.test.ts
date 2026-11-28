/**
 * A new worktree starts without the PreToolUse gates, because they live in the ignored,
 * per-checkout `.claude/` (the marker and `settings.local.json`). On a machine whose main checkout
 * is gated, an agent working in the new worktree then ran ungated. These tests use real git
 * repositories and real linked worktrees.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  gateLiveness,
  installEnvWriteGate,
  installInstallGate,
  markGatesInstalled,
} from "./agent-config.js";
import { CREDENTIAL_DIRS, KIT_DENY_RULES, installStrictSettings } from "./agent-config-strict.js";
import { ensureWorktreeGates } from "./worktree-gates.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { ensureKitWrapper } from "./kit-wrapper.js";

let fixtureHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
  fixtureHome = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-wt-gates-home-")));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = fixtureHome;
  process.env.USERPROFILE = fixtureHome;
  const cliPath = fileURLToPath(
    new URL(import.meta.url.endsWith(".ts") ? "../dist/cli.js" : "./cli.js", import.meta.url),
  );
  const wrapper = ensureKitWrapper({ home: fixtureHome, cliPath });
  assert.equal(wrapper.action, "written");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmTemp(fixtureHome);
});

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

function repo(gatedMain: boolean, opts: { trackClaudeMd?: boolean } = {}): Repo {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-wt-gates-")));
  const main = join(root, "main");
  const wt = join(root, "wt");
  execFileSync("git", ["init", "-q", main]);
  mkdirSync(join(main, ".claude"), { recursive: true });
  writeFileSync(join(main, "CLAUDE.md"), "# project\n");
  writeFileSync(join(main, ".gitignore"), ".claude/\n");
  git(main, "add", ...(opts.trackClaudeMd === false ? [] : ["CLAUDE.md"]), ".gitignore");
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

  it("wires the gates when neither `.claude/` nor CLAUDE.md is tracked", async () => {
    // Was: the installers saw no Claude Code project in the new worktree and skipped, so the
    // worktree stayed ungated while the main checkout was gated (measured with Orca, which
    // starts every agent in a new worktree).
    const r = repo(true, { trackClaudeMd: false });
    try {
      await installGates(r.main);
      assert.equal(existsSync(join(r.wt, "CLAUDE.md")), false, "precondition: nothing tracked");
      const got = await ensureWorktreeGates(r.wt, installGates);
      assert.equal(got.outcome, "installed", got.detail);
      const live = gateLiveness(r.wt);
      assert.equal(live.installGate, true);
      assert.equal(live.envGate, true);
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
});

describe("ensureWorktreeGates: when it does nothing or fails", () => {
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

interface Settings {
  permissions?: { deny?: string[] };
  sandbox?: { enabled?: boolean; filesystem?: { denyRead?: string[] } };
}

const settingsOf = (cwd: string): Settings => {
  const path = join(cwd, ".claude", "settings.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Settings) : {};
};

describe("ensureWorktreeGates: the deny floor", () => {
  it("writes kit's deny rules and sandbox block in a worktree of a checkout that has them", async () => {
    // Was: only the hooks were mirrored. The deny rules live in the same ignored `.claude/`, so the
    // new worktree allowed `Read(~/.ssh/**)`, `.env*` and force push that the main checkout refused.
    const r = repo(true);
    try {
      await installGates(r.main);
      assert.equal((await installStrictSettings(r.main)).action, "updated");
      assert.equal(settingsOf(r.wt).permissions?.deny, undefined, "precondition: no deny rule");
      const got = await ensureWorktreeGates(r.wt, installGates);
      assert.equal(got.outcome, "installed", got.detail);
      assert.deepEqual(settingsOf(r.wt).permissions?.deny, KIT_DENY_RULES);
      if (process.platform !== "win32") {
        assert.equal(settingsOf(r.wt).sandbox?.enabled, true);
        assert.deepEqual(settingsOf(r.wt).sandbox?.filesystem?.denyRead, CREDENTIAL_DIRS);
      }
      assert.equal(git(r.wt, "status", "--short").trim(), "", "no tracked file changes");
    } finally {
      rmTemp(r.root);
    }
  });

  it("adds the floor to a worktree that already has the hooks", async () => {
    const r = repo(true);
    try {
      await installGates(r.main);
      await installStrictSettings(r.main);
      await installGates(r.wt);
      const got = await ensureWorktreeGates(r.wt, installGates);
      assert.equal(got.outcome, "installed", got.detail);
      assert.deepEqual(settingsOf(r.wt).permissions?.deny, KIT_DENY_RULES);
    } finally {
      rmTemp(r.root);
    }
  });

  it("writes no deny rule when the main checkout has none", async () => {
    const r = repo(true);
    try {
      await installGates(r.main);
      await ensureWorktreeGates(r.wt, installGates);
      assert.equal(settingsOf(r.wt).permissions?.deny, undefined);
    } finally {
      rmTemp(r.root);
    }
  });

  it("reports failed when the floor could not be written", async () => {
    const r = repo(true);
    try {
      await installGates(r.main);
      await installStrictSettings(r.main);
      const got = await ensureWorktreeGates(r.wt, installGates, async () => {});
      assert.equal(got.outcome, "failed");
      assert.match(got.detail, /deny rules are not all/);
    } finally {
      rmTemp(r.root);
    }
  });
});
