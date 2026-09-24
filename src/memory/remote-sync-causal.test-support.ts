import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { openMemoryDb } from "./db.js";
import { palAdd, palShow } from "./pal.js";
import { pullMemory, pushMemory, type SyncConfig } from "./remote-sync.js";

const passphrase = "Causal-History-Copper-9573";
type Device = "a" | "b" | "c" | "d";

function isolatedGitEnv(dir: string): Record<string, string | undefined> {
  return {
    KIT_MEMORY_DIR: join(dir, "a"),
    KIT_MEMORY_DB: join(dir, "a", "memory.db"),
    KIT_DEVICE_ID: "causal-git-a",
    KIT_MEMORY_ALLOW_UNSAFE: undefined,
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG: undefined,
    GIT_DIR: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_TEMPLATE_DIR: join(dir, "templates"),
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Memory acceptance fixture",
    GIT_AUTHOR_EMAIL: "memory-fixture@localhost",
    GIT_COMMITTER_NAME: "Memory acceptance fixture",
    GIT_COMMITTER_EMAIL: "memory-fixture@localhost",
  };
}

function applyEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function gitHistoryFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-causal-git-"));
  const isolated = isolatedGitEnv(dir);
  const previous = Object.fromEntries(Object.keys(isolated).map((key) => [key, process.env[key]]));
  t.after(() => {
    applyEnv(previous);
    rmSync(dir, { recursive: true, force: true });
  });
  applyEnv(isolated);
  writeFileSync(isolated.GIT_CONFIG_GLOBAL!, "");
  mkdirSync(isolated.GIT_TEMPLATE_DIR!);
  const remote = join(dir, "memory.git");
  execFileSync("git", ["init", "--bare", "-q", remote], {
    cwd: dir,
    stdio: "pipe",
    timeout: 10_000,
  });
  const config: SyncConfig = {
    transport: "git",
    remote: pathToFileURL(remote).href,
    branch: "main",
    file: "memory.enc",
    encrypt: true,
  };
  return {
    dir,
    config,
    device(name: Device) {
      process.env.KIT_MEMORY_DIR = join(dir, name);
      process.env.KIT_MEMORY_DB = join(dir, name, "memory.db");
      process.env.KIT_DEVICE_ID = `causal-git-${name}`;
    },
    async memory<T>(run: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
      const db = openMemoryDb();
      try {
        return await run(db);
      } finally {
        db.close();
      }
    },
    push() {
      const result = pushMemory(config, passphrase, dir);
      assert.equal(result.verified, true);
      assert.equal(result.pushed, true);
      return result;
    },
    pull() {
      const result = pullMemory(config, passphrase, dir);
      assert.equal(result.found, true);
      assert.ok(result.merge);
      return result.merge;
    },
  };
}

export async function commonGitTask(t: TestContext) {
  const files = gitHistoryFixture(t);
  const id = await files.memory((db) => palAdd(db, { title: "Check sandbox receipt" }));
  const origin = await files.memory((db) => palShow(db, id, { history: true }));
  assert.ok(origin);
  files.push();
  files.device("b");
  assert.equal(files.pull().pendingStateDifferences, 0);
  assert.deepEqual(await files.memory((db) => palShow(db, id, { history: true })), origin);
  return { ...files, id, origin };
}
