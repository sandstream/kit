import type { TestContext } from "node:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { insertMessage, openMemoryDb, upsertSession } from "./db.js";

const exec = promisify(execFile);

export function registerWorktree(root: string, worktree: string, name: string): void {
  mkdirSync(worktree, { recursive: true });
  const gitdir = join(root, ".git", "worktrees", name);
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(join(gitdir, "gitdir"), join(worktree, ".git") + "\n");
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  writeFileSync(join(gitdir, "HEAD"), `ref: refs/heads/${name}\n`);
}

export async function originFixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kit-thread-origin-")));
  const root = join(directory, "main");
  const sibling = join(directory, "review");
  mkdirSync(root);
  mkdirSync(sibling);
  const environment = {
    KIT_MEMORY_DIR: join(directory, "state"),
    KIT_MEMORY_DB: join(directory, "state", "memory.db"),
    KIT_DEVICE_ID: "thread-origin-fixture",
    KIT_IDENTITY_DIR: join(directory, "identity"),
    KIT_CLAUDE_DIR: join(directory, "claude"),
    KIT_CODEX_DIR: join(directory, "codex"),
    KIT_NO_UPDATE_CHECK: "1",
    KIT_AUDIT_ANCHOR: "0",
    KIT_AIRGAP: "1",
    KIT_NON_INTERACTIVE: "1",
  };
  const previous = Object.keys(environment).map((key) => [key, process.env[key]] as const);
  let closeDb = () => {};
  Object.assign(process.env, environment);
  t.after(() => {
    closeDb();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  await exec("git", ["init", "-q", root]);
  // Register an unborn sibling worktree without a commit or a running service.
  registerWorktree(root, sibling, "review");
  const db = openMemoryDb(environment.KIT_MEMORY_DB);
  closeDb = () => db.close();
  const source = import.meta.url.endsWith(".ts");
  const runner = [
    ...(source ? ["--import", import.meta.resolve("tsx")] : []),
    fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url)),
  ];
  const memory = async (cwd: string, ...args: string[]) => {
    const result = await exec(process.execPath, [...runner, "memory", ...args], {
      cwd,
      env: { ...process.env, ...environment },
      timeout: 30_000,
    });
    return stripVTControlCharacters(result.stdout);
  };
  const record = (
    sessionId: string,
    cwd: string | undefined,
    timestamp: string,
    harness = "codex",
  ) => {
    upsertSession(db, { sessionId, harness });
    insertMessage(db, {
      uuid: `${sessionId}-${timestamp}`,
      sessionId,
      type: "assistant",
      content: "Synthetic bookmark history",
      cwd,
      timestamp,
    });
  };
  return { directory, root, sibling, db, memory, record };
}
