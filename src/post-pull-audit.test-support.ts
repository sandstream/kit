import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { rmTemp } from "./temp-cleanup.test-support.js";

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitInput(dir: string, input: string | Buffer, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=", ...args], {
    cwd: dir,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Build raw Git paths without checking them out through the host filesystem. */
export function manifestTreeRange(
  dir: string,
  names: [Buffer, Buffer],
  after: string,
): { base: string; head: string } {
  const manifestTree = (content: string): string => {
    const blob = gitInput(dir, content, "hash-object", "-w", "--stdin");
    return gitInput(dir, `100644 blob ${blob}\tpackage.json\0`, "mktree", "-z");
  };
  const original = manifestTree('{"dependencies":{"example":"1.0.0"}}');
  const rootTree = (first: string): string =>
    gitInput(
      dir,
      Buffer.concat([
        Buffer.from(`040000 tree ${first}\t`),
        names[0],
        Buffer.from("\0"),
        Buffer.from(`040000 tree ${original}\t`),
        names[1],
        Buffer.from("\0"),
      ]),
      "mktree",
      "-z",
    );
  const base = gitInput(dir, "fixture base", "commit-tree", rootTree(original), "-p", "HEAD");
  const head = gitInput(
    dir,
    "fixture head",
    "commit-tree",
    rootTree(manifestTree(after)),
    "-p",
    base,
  );
  return { base, head };
}

export function repo(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-pull-integrity-"));
  t.after(() => rmTemp(dir));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  write(dir, "package.json", '{"dependencies":{"example":"1.0.0"}}');
  commit(dir);
  return dir;
}

export function write(dir: string, file: string, content: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
}

export function commit(dir: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fixture", "--allow-empty");
}

export function cli(dir: string, ...args: string[]): { status: number | null; output: string } {
  return runNode(dir, [
    fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
    "security",
    "verify-pull",
    ...args,
  ]);
}

export function runNode(dir: string, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, args, {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      KIT_NON_INTERACTIVE: "1",
      KIT_BUMBLEBEE: "0",
      KIT_NO_FAILURE_SIM: "1",
      KIT_NO_UPDATE_CHECK: "1",
      KIT_AUDIT_ANCHOR: "0",
      KIT_HIDE_HOOK_SKIP_BANNER: "1",
      KIT_READ_ONLY: "1",
      NODE_NO_WARNINGS: "1", // stderr is read with stdout; a warning would break the JSON parse
    },
  });
  assert.ifError(result.error);
  return { status: result.status, output: stripVTControlCharacters(result.stdout + result.stderr) };
}
