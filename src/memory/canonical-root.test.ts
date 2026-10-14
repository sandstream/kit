import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getCanonicalProjectRoot } from "./canonical-root.js";

let base: string;
let main: string;
let linked: string;

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-canon-")));
  main = join(base, "main");
  linked = join(base, "linked");
  mkdirSync(main);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: main, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "linked", linked);
  mkdirSync(join(main, "sub"));
});

after(() => rmSync(base, { recursive: true, force: true }));

describe("getCanonicalProjectRoot", () => {
  it("resolves a linked worktree to the main checkout", () => {
    assert.equal(realpathSync.native(getCanonicalProjectRoot(linked)), main);
  });

  it("leaves the main checkout, and a subdirectory of it, at the main checkout", () => {
    assert.equal(realpathSync.native(getCanonicalProjectRoot(main)), main);
    assert.equal(realpathSync.native(getCanonicalProjectRoot(join(main, "sub"))), main);
  });

  it("falls back to the directory itself outside a git repo", () => {
    const plain = realpathSync.native(mkdtempSync(join(tmpdir(), "kit-canon-plain-")));
    try {
      assert.equal(getCanonicalProjectRoot(plain), plain);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
