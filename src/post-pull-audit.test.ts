import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { auditPull, defaultPullBase, reportSeverity } from "./post-pull-audit.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTemp } from "./temp-cleanup.test-support.js";

function git(dir: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: dir });
}

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-audit-pull-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  return dir;
}

function commit(dir: string, msg: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
}

describe("auditPull", () => {
  it("returns empty report when nothing changed", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "README.md"), "# repo\n");
      commit(dir, "initial");
      writeFileSync(join(dir, "README.md"), "# repo (updated)\n");
      commit(dir, "edit readme");
      const r = await auditPull(dir);
      assert.equal(r.newDependencies.length, 0);
      assert.equal(r.plaintextHits.length, 0);
      assert.equal(reportSeverity(r), "ok");
    } finally {
      rmTemp(dir);
    }
  });

  it("detects new dependencies in package.json", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "t", dependencies: { next: "^15.0.0" } }, null, 2),
      );
      commit(dir, "initial");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify(
          {
            name: "t",
            dependencies: { next: "^15.0.0", "left-pad": "1.3.0" },
          },
          null,
          2,
        ),
      );
      commit(dir, "add dep");
      const r = await auditPull(dir);
      assert.deepEqual(r.newDependencies, ["left-pad"]);
      assert.equal(reportSeverity(r), "warn");
    } finally {
      rmTemp(dir);
    }
  });

  it("flags removed .gitignore entries as sensitive when env/key-related", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules\n*.pem\n");
      commit(dir, "initial");
      writeFileSync(join(dir, ".gitignore"), "node_modules\n");
      commit(dir, "loosen ignore");
      const r = await auditPull(dir);
      assert.ok(r.removedGitignoreEntries.includes(".env"));
      assert.ok(r.removedGitignoreEntries.includes("*.pem"));
      assert.equal(reportSeverity(r), "fail");
    } finally {
      rmTemp(dir);
    }
  });

  it("flags introduced plaintext secrets", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(join(dir, "README.md"), "# repo\n");
      commit(dir, "initial");
      writeFileSync(
        join(dir, "config.ts"),
        'export const KEY = "' + "sk_" + "test_51T2AMtJLRlXeUG4dKBwX2nsve3BLEzy" + '";\n',
      );
      commit(dir, "add config");
      const r = await auditPull(dir);
      assert.equal(r.plaintextHits.length, 1);
      assert.equal(r.plaintextHits[0].file, "config.ts");
      assert.equal(reportSeverity(r), "fail");
    } finally {
      rmTemp(dir);
    }
  });

  it("flags kit security-config file changes", async () => {
    const dir = tmpRepo();
    try {
      writeFileSync(
        join(dir, ".kit-allowlist.json"),
        JSON.stringify(
          {
            policy: { enforce_runtime: true, enforce_dev: false, allow_wildcards: false },
            packages: [],
          },
          null,
          2,
        ),
      );
      commit(dir, "initial");
      writeFileSync(
        join(dir, ".kit-allowlist.json"),
        JSON.stringify(
          {
            policy: { enforce_runtime: false, enforce_dev: false, allow_wildcards: true },
            packages: [],
          },
          null,
          2,
        ),
      );
      commit(dir, "relax allowlist");
      const r = await auditPull(dir);
      assert.equal(r.allowlistChanged, true);
      assert.equal(reportSeverity(r), "warn");
    } finally {
      rmTemp(dir);
    }
  });
});

describe("defaultPullBase: the whole pull, not its last commit", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");

  /** An upstream with two new commits, the dependency in the FIRST, pulled by fast-forward. */
  function pulledTwoCommits(): { root: string; clone: string } {
    const root = mkdtempSync(join(tmpdir(), "kit-pull-range-"));
    const up = join(root, "up");
    git(root, "init", "-q", up);
    git(up, "config", "user.email", "t@t");
    git(up, "config", "user.name", "t");
    writeFileSync(join(up, "package.json"), '{"name":"x","dependencies":{}}\n');
    commit(up, "initial");
    const clone = join(root, "me");
    git(root, "clone", "-q", up, clone);
    writeFileSync(join(up, "package.json"), '{"name":"x","dependencies":{"left-padd":"1.0.0"}}\n');
    commit(up, "add a dependency");
    writeFileSync(join(up, "README.md"), "# x\n");
    commit(up, "readme");
    git(clone, "pull", "-q", "--ff-only");
    return { root, clone };
  }

  it("uses ORIG_HEAD after a multi-commit pull, so a dependency in an earlier commit is seen", async (t) => {
    const { root, clone } = pulledTwoCommits();
    t.after(() => rmTemp(root));
    assert.deepEqual(await defaultPullBase(clone), { base: "ORIG_HEAD", fallback: false });
    const whole = await auditPull(clone, "ORIG_HEAD");
    assert.deepEqual(whole.newDependencies, ["left-padd"]);
    // The old default saw only the README commit and reported nothing.
    assert.deepEqual((await auditPull(clone, "HEAD~1")).newDependencies, []);
  });

  it("falls back to HEAD~1, and says so, when there is no ORIG_HEAD", async (t) => {
    const dir = tmpRepo();
    t.after(() => rmTemp(dir));
    writeFileSync(join(dir, "a"), "1");
    commit(dir, "one");
    writeFileSync(join(dir, "a"), "2");
    commit(dir, "two");
    assert.deepEqual(await defaultPullBase(dir), { base: "HEAD~1", fallback: true });
  });

  it("falls back when ORIG_HEAD is not an ancestor of HEAD (a reset set it)", async (t) => {
    const dir = tmpRepo();
    t.after(() => rmTemp(dir));
    for (const n of ["1", "2", "3"]) {
      writeFileSync(join(dir, "a"), n);
      commit(dir, n);
    }
    git(dir, "reset", "-q", "--hard", "HEAD~1"); // ORIG_HEAD is now a descendant
    assert.deepEqual(await defaultPullBase(dir), { base: "HEAD~1", fallback: true });
  });

  it("kit security verify-pull with no --base warns about the earlier commit's dependency", async (t) => {
    const { root, clone } = pulledTwoCommits();
    t.after(() => rmTemp(root));
    const out = execFileSync(process.execPath, [CLI, "security", "verify-pull", "--json"], {
      cwd: clone,
      encoding: "utf8",
      env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1" },
      timeout: 60_000,
    });
    const r = JSON.parse(out) as { baseRef: string; newDependencies: string[] };
    assert.equal(r.baseRef, "ORIG_HEAD");
    assert.deepEqual(r.newDependencies, ["left-padd"]);
  });
});
