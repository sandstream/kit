import { describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPinnedVersions } from "./check-security.js";

// A committed npm lockfile that matches package.json resolves its ranges (check-pinned-lockfile.ts).
// Each case runs in a real temporary git repo, because "committed" means tracked by git.

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

describe("checkPinnedVersions with a committed npm lockfile", () => {
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
