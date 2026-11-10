import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPinnedVersions } from "./check-security.js";

// "pinned versions" used to answer `pass — all dependencies pinned` for a repo with no
// manifest, for an unparseable package.json, and for a requirements.txt of bare names:
// it only treated `>`, `~` and `!` as unpinned. Each case below passed before this file.

async function inRepo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "kit-pinned-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return await checkPinnedVersions(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("checkPinnedVersions", () => {
  it("skips, never passes, when there is no manifest to read", async () => {
    const r = await inRepo({});
    assert.strictEqual(r.status, "skip");
    assert.match(r.detail, /no package\.json or requirements\.txt/);
  });

  it("warns when package.json cannot be parsed", async () => {
    const r = await inRepo({ "package.json": '{"dependencies": {"left-pad": "*"},}' });
    assert.strictEqual(r.status, "warn");
    assert.match(r.detail, /could not be parsed/);
  });

  it("warns on a requirements.txt of bare names", async () => {
    const r = await inRepo({ "requirements.txt": "fastapi\nuvicorn\n" });
    assert.strictEqual(r.status, "warn");
    assert.strictEqual(r.detail, "2 unpinned dependencies");
  });

  it("names the manifests it read when everything is pinned", async () => {
    const r = await inRepo({
      "package.json": JSON.stringify({ dependencies: { a: "1.2.3" } }),
      "requirements.txt": "fastapi==0.115.0\n",
    });
    assert.strictEqual(r.status, "pass");
    assert.strictEqual(r.detail, "all dependencies pinned (package.json, requirements.txt)");
  });

  describe("with a committed npm lockfile", () => {
    const manifest = { dependencies: { a: "^1.2.0" }, devDependencies: { b: "~2.0.0" } };
    const lock = (deps = manifest) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { dependencies: deps.dependencies, devDependencies: deps.devDependencies },
          "node_modules/a": { version: "1.2.3" },
          "node_modules/b": { version: "2.0.1" },
        },
      });

    async function inGitRepo(files: Record<string, string>, commit: string[]) {
      const dir = mkdtempSync(join(tmpdir(), "kit-pinned-git-"));
      try {
        for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
        const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
        git("init", "-q");
        if (commit.length) git("add", "--", ...commit);
        return await checkPinnedVersions(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("passes when the lockfile is tracked and matches package.json", async () => {
      const r = await inGitRepo(
        { "package.json": JSON.stringify(manifest), "package-lock.json": lock() },
        ["package.json", "package-lock.json"],
      );
      assert.strictEqual(r.status, "pass");
      assert.match(r.detail, /2 ranges? resolved by the committed package-lock\.json/);
    });

    it("warns when the lockfile is not tracked by git", async () => {
      const r = await inGitRepo(
        { "package.json": JSON.stringify(manifest), "package-lock.json": lock() },
        ["package.json"],
      );
      assert.strictEqual(r.status, "warn");
      assert.strictEqual(r.detail, "2 unpinned dependencies");
    });

    it("warns when the lockfile is out of sync with package.json", async () => {
      const stale = { dependencies: { a: "^1.1.0" }, devDependencies: { b: "~2.0.0" } };
      const r = await inGitRepo(
        { "package.json": JSON.stringify(manifest), "package-lock.json": lock(stale) },
        ["package.json", "package-lock.json"],
      );
      assert.strictEqual(r.status, "warn");
      assert.match(r.detail, /2 unpinned dependencies.*out of sync/);
    });

    it("keeps warning under [scan] strict_pins = true", async () => {
      const r = await inGitRepo(
        {
          "package.json": JSON.stringify(manifest),
          "package-lock.json": lock(),
          ".kit.toml": "[scan]\nstrict_pins = true\n",
        },
        ["package.json", "package-lock.json"],
      );
      assert.strictEqual(r.status, "warn");
      assert.strictEqual(r.detail, "2 unpinned dependencies");
    });
  });
});
