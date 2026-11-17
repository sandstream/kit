import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGitEmail, isNoReply, maskEmail } from "./check-git-email.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  git(...args: string[]): void;
}

/** A temp project and HOME; git reads no system, user or inherited config but the fixture's. */
function fixture(t: { after(fn: () => void): void }, init = true): Fixture {
  const base = mkdtempSync(join(tmpdir(), "kit-git-email-"));
  t.after(() => rmTemp(base));
  const root = join(base, "project");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  });
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
  };
  if (init) git("init", "-q");
  return { root, env, git };
}

describe("checkGitEmail", () => {
  it("returns no row outside a git work tree", async (t) => {
    const { root, env, git } = fixture(t, false);
    git("config", "--global", "user.email", "alice@example.com");
    assert.deepEqual(await checkGitEmail(root, env), []);
  });

  it("skips when no user.email is set", async (t) => {
    const { root, env } = fixture(t);
    const [row] = await checkGitEmail(root, env);
    assert.equal(row?.status, "skip");
  });

  it("warns on a real-looking address and prints it masked only", async (t) => {
    const { root, env, git } = fixture(t);
    git("config", "--global", "user.email", "alice@example.com");
    const [row] = await checkGitEmail(root, env);
    assert.equal(row?.status, "warn");
    assert.equal(row?.severity, "low");
    assert.equal(row?.category, "exposure");
    assert.match(row?.detail ?? "", /a\*\*\*@example\.com/);
    assert.doesNotMatch(JSON.stringify(row), /alice/);
    assert.ok((row?.suggestion ?? "").includes("@users.noreply.github.com"), row?.suggestion);
  });

  it("passes a GitHub no-reply address", async (t) => {
    const { root, env, git } = fixture(t);
    git("config", "--global", "user.email", "12345+alice@users.noreply.github.com");
    const [row] = await checkGitEmail(root, env);
    assert.equal(row?.status, "pass");
    assert.doesNotMatch(JSON.stringify(row), /alice/);
  });

  it("reads the repo-local address over the global one", async (t) => {
    const { root, env, git } = fixture(t);
    git("config", "--global", "user.email", "12345+alice@users.noreply.github.com");
    git("config", "user.email", "bob@example.org");
    const [row] = await checkGitEmail(root, env);
    assert.equal(row?.status, "warn");
    assert.match(row?.detail ?? "", /b\*\*\*@example\.org/);
  });
});

describe("isNoReply", () => {
  it("accepts hosted and obvious no-reply addresses", () => {
    for (const e of [
      "12345+alice@users.noreply.github.com",
      "alice@users.noreply.github.com",
      "123-alice@users.noreply.gitlab.com",
      "noreply@example.com",
      "no-reply+ci@example.com",
      "bot@noreply.example.com",
    ]) {
      assert.equal(isNoReply(e), true, e);
    }
  });

  it("rejects real-looking addresses", () => {
    for (const e of [
      "alice@example.com",
      "noreplyalice@example.com",
      "nope",
      "@users.noreply.github.com",
    ]) {
      assert.equal(isNoReply(e), false, e);
    }
  });
});

describe("maskEmail", () => {
  it("keeps the first character and the domain", () => {
    assert.equal(maskEmail("alice@example.com"), "a***@example.com");
  });

  it("masks a value that is not an address entirely", () => {
    assert.equal(maskEmail("alice"), "***");
  });
});
