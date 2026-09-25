import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEnvGitignored, gateStatus } from "./check-security.js";
import { checkGitignore, findCommittedSensitive, patchGitignore } from "./check-gitignore.js";

function repo(t: { after: (fn: () => void) => void }, ignore = ".env*\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-effective-ignore-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, ".gitignore"), ignore);
  return dir;
}

describe("effective Git ignore protection", () => {
  it("honors rule order and leaves tracked templates allowed", async (t) => {
    const dir = repo(t, "!.env.keys\n.env*\n!.env.example\n!.env.staging.template\n");
    writeFileSync(join(dir, ".env.example"), "EXAMPLE=\n");
    writeFileSync(join(dir, ".env.staging.template"), "EXAMPLE=\n");
    execFileSync("git", ["add", "--", ".env.example", ".env.staging.template"], { cwd: dir });
    assert.equal((await checkEnvGitignored(dir)).status, "pass");
  });

  it("rejects a later negation of .env.keys", async (t) => {
    const dir = repo(t, ".env*\n!.env.keys\n");
    assert.equal(spawnSync("git", ["check-ignore", "-q", ".env.keys"], { cwd: dir }).status, 1);
    const result = await checkEnvGitignored(dir);
    assert.equal(result.status, "fail");
    assert.match(result.detail, /\.env\.keys/);
  });

  it("detects already tracked secrets even when ignore rules match", async (t) => {
    const dir = repo(t);
    writeFileSync(join(dir, ".env.keys"), "fixture only\n");
    execFileSync("git", ["add", "-f", "--", ".env.keys"], { cwd: dir });
    const result = await checkEnvGitignored(dir);
    assert.equal(result.status, "fail");
    assert.match(result.detail, /tracked/);
    assert.ok(result.files?.includes(".env.keys"));
  });

  it("commented and inline-commented patterns provide no protection", async (t) => {
    const dir = repo(t, "# .env .env.local .env.*.local .env.keys\n.env* # secrets\n");
    assert.equal((await checkEnvGitignored(dir)).status, "fail");
  });

  it("accepts effective rules from Git's exclude file", async (t) => {
    const dir = repo(t, "");
    writeFileSync(join(dir, ".git", "info", "exclude"), ".env*\n");
    assert.equal((await checkEnvGitignored(dir)).status, "pass");
  });
});

describe("Git verification availability", () => {
  it("a non-repository cannot earn a pass from pattern text", async (t) => {
    const dir = repo(t);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const result = await checkEnvGitignored(dir);
    assert.notEqual(result.status, "pass");
    assert.equal(result.didNotRun, true);
    assert.equal(gateStatus(result), "fail");
    assert.match(result.detail, /Git|git/);
    await assert.rejects(checkGitignore(dir), /Git|git/);
    await assert.rejects(findCommittedSensitive(dir), /Git|git/);
  });

  it("reports missing Git explicitly and cannot repair without verification", async (t) => {
    const dir = repo(t);
    const previous = process.env.PATH;
    process.env.PATH = dir;
    try {
      const result = await checkEnvGitignored(dir);
      assert.equal(result.didNotRun, true);
      assert.equal(gateStatus(result), "fail");
      assert.match(result.detail, /Git|git/);
      await assert.rejects(patchGitignore(dir), /Git|git/);
    } finally {
      process.env.PATH = previous;
    }
  });

  it("Git command errors cannot look like ignored files", async (t) => {
    const dir = repo(t);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 128\n");
    chmodSync(join(bin, "git"), 0o755);
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const result = await checkEnvGitignored(dir);
      assert.equal(result.didNotRun, true);
      assert.equal(gateStatus(result), "fail");
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe("Git-verified repair", () => {
  it("the repair check also rejects a negated pattern", async (t) => {
    const dir = repo(t, ".env*\n!.env.keys\n");
    const result = await checkGitignore(dir);
    assert.ok(result.missingPatterns.some((entry) => entry.pattern === ".env.keys"));
    await patchGitignore(dir);
    assert.equal(spawnSync("git", ["check-ignore", "-q", ".env.keys"], { cwd: dir }).status, 0);
    assert.equal((await checkEnvGitignored(dir)).status, "pass");
  });

  it("finds existing nested secrets exposed by a nested negation", async (t) => {
    const dir = repo(t);
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", ".gitignore"), "!.env.keys\n");
    writeFileSync(join(dir, "app", ".env.keys"), "fixture only\n");
    const result = await checkEnvGitignored(dir);
    assert.equal(result.status, "fail");
    assert.ok(result.files?.includes("app/.env.keys"));
    await assert.rejects(patchGitignore(dir), /app\/\.env\.keys/);
    assert.equal(readFileSync(join(dir, "app", ".env.keys"), "utf8"), "fixture only\n");
  });

  it("preserves tracked paths with special characters and never untracks them", async (t) => {
    const dir = repo(t);
    // Windows forbids newlines in names; a space still exercises Git's quoted
    // path handling while POSIX covers the newline case.
    const folder = process.platform === "win32" ? "app name" : "app\nname";
    const path = `${folder}/.env.keys`;
    mkdirSync(join(dir, folder));
    writeFileSync(join(dir, path), "fixture only\n");
    execFileSync("git", ["add", "-f", "--", path], { cwd: dir });
    assert.deepEqual(await findCommittedSensitive(dir), [path]);
    assert.equal((await checkEnvGitignored(dir)).status, "fail");
    await assert.rejects(patchGitignore(dir), /tracked/);
    assert.equal(readFileSync(join(dir, path), "utf8"), "fixture only\n");
    assert.equal(
      execFileSync("git", ["ls-files", "-z"], { cwd: dir, encoding: "utf8" }),
      `${path}\0`,
    );
  });

  it("re-patches after late negations without dropping earlier protection or user lines", async (t) => {
    const dir = repo(t);
    await patchGitignore(dir);
    const first = readFileSync(join(dir, ".gitignore"), "utf8");
    const userTail = "\n# keep this\n!.env.keys\n!server.pem\nuser-file\n";
    writeFileSync(join(dir, ".gitignore"), first + userTail);
    await patchGitignore(dir);
    const second = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.ok(second.includes(userTail.trimStart()));
    assert.equal((await checkGitignore(dir)).missingPatterns.length, 0);
    for (const path of [".env", ".env.keys", "server.pem", "id_rsa"]) {
      assert.equal(
        spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: dir }).status,
        0,
        path,
      );
    }
    assert.equal((await patchGitignore(dir)).written, false);
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), second);
  });
});

describe("repair preserves literal paths", () => {
  it("keeps existing literal repairs when another pattern needs re-patching", async (t) => {
    const dir = repo(t, ".env\n");
    const path = ".env.deployment[1]";
    writeFileSync(join(dir, path), "fixture only\n");
    await patchGitignore(dir);
    const first = readFileSync(join(dir, ".gitignore"), "utf8");
    writeFileSync(join(dir, ".gitignore"), first + "!server.pem\n");
    await patchGitignore(dir);
    assert.equal(spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: dir }).status, 0);
    assert.equal(readFileSync(join(dir, path), "utf8"), "fixture only\n");
  });
});

it("repair reopens only root shared memory and preserves nested private kit state", async (t) => {
  const dir = repo(t, ".env*\n.kit/\n");
  const privatePaths = [".kit/env/local", "packages/app/.kit/env/local"];
  const shared = ".kit/shared/memory.jsonl";
  for (const path of [...privatePaths, shared]) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), "fixture only\n");
    assert.equal(spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: dir }).status, 0);
  }

  await patchGitignore(dir);
  for (const path of privatePaths) {
    assert.equal(
      spawnSync("git", ["check-ignore", "-q", "--", path], { cwd: dir }).status,
      0,
      path,
    );
  }
  assert.equal(spawnSync("git", ["check-ignore", "-q", "--", shared], { cwd: dir }).status, 1);
  assert.equal((await patchGitignore(dir)).written, false);
});

describe("Git repository selection", () => {
  it("an inherited Git index cannot hide the governed repository's tracked secrets", async (t) => {
    const dir = repo(t);
    const other = repo(t);
    writeFileSync(join(dir, ".env.keys"), "fixture only\n");
    execFileSync("git", ["add", "-f", "--", ".env.keys"], { cwd: dir });
    const previous = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = join(other, ".git", "index");
    try {
      assert.equal((await checkEnvGitignored(dir)).status, "fail");
      assert.deepEqual(await findCommittedSensitive(dir), [".env.keys"]);
    } finally {
      if (previous === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = previous;
    }
  });
});

describe("standalone gitignore command", () => {
  it("reports nonrepo and missing-Git errors through the CLI", (t) => {
    const dir = repo(t);
    writeFileSync(join(dir, ".kit.toml"), "version = 1\n");
    const runner = import.meta.url.endsWith(".ts")
      ? [
          "--import",
          import.meta.resolve("tsx"),
          fileURLToPath(new URL("./cli.ts", import.meta.url)),
        ]
      : [fileURLToPath(new URL("./cli.js", import.meta.url))];
    const args = [...runner, "security", "check-gitignore"];
    const env = { ...process.env, KIT_NO_UPDATE_CHECK: "1", KIT_HIDE_HOOK_SKIP_BANNER: "1" };
    const missingGit = spawnSync(process.execPath, args, {
      cwd: dir,
      env: { ...env, PATH: dir },
      encoding: "utf8",
    });
    assert.equal(missingGit.status, 1);
    assert.match(missingGit.stderr, /Git.*could not be verified/);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const nonrepo = spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8" });
    assert.equal(nonrepo.status, 1);
    assert.match(nonrepo.stderr, /Git.*could not be verified/);
  });
});
