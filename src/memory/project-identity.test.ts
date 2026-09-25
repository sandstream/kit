import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { insertMessage, openMemoryDb, searchMessages, upsertSession } from "./db.js";
import { mergeDb } from "./merge.js";
import { getProjectIdentity, initializeProjectIdentity } from "./project.js";
import { listThreads, saveThread } from "./threads.js";

it("recalls imported work in another clone carrying the same explicit project identity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kit-project-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sourceRoot = join(dir, "source-clone");
  const targetRoot = join(dir, "target-clone");
  const config = '[memory]\nproject_id = "018f55d8-df5d-7f2a-a8c9-e3518d89d42f"\n';
  for (const root of [sourceRoot, targetRoot]) {
    mkdirSync(root);
    writeFileSync(join(root, ".kit.toml"), config);
  }

  const sourcePath = join(dir, "source.db");
  const source = openMemoryDb(sourcePath);
  upsertSession(source, { sessionId: "source-session", harness: "codex" });
  insertMessage(source, {
    uuid: "portable-message",
    sessionId: "source-session",
    type: "assistant",
    content: "stableidentitymarker from source clone",
    cwd: sourceRoot,
  });
  saveThread(source, {
    name: "portable-thread",
    sessionId: "source-session",
    projectPath: sourceRoot,
  });
  source.close();

  const target = openMemoryDb(join(dir, "target.db"));
  try {
    mergeDb(target, sourcePath);
    assert.equal(
      searchMessages(target, "stableidentitymarker", { projectPath: targetRoot }).length,
      1,
    );
    assert.deepEqual(
      listThreads(target, { projectPath: targetRoot }).map((thread) => thread.name),
      ["portable-thread"],
    );
  } finally {
    target.close();
  }
});

it(
  "initializes one durable project identity through the real CLI and reuses it",
  { timeout: 90_000 },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "kit-project-identity-cli-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, ".kit.toml"), 'version = 1\n\n[tools]\nnode = "22"\n');
    const source = import.meta.url.endsWith(".ts");
    const cli = fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url));
    const run = () =>
      spawnSync(
        process.execPath,
        [
          ...(source ? ["--import", import.meta.resolve("tsx")] : []),
          cli,
          "memory",
          "project",
          "init",
          "--json",
        ],
        {
          cwd: dir,
          encoding: "utf8",
          env: {
            ...process.env,
            KIT_MEMORY_DIR: join(dir, ".memory"),
            KIT_NO_UPDATE_CHECK: "1",
            KIT_NON_INTERACTIVE: "1",
          },
        },
      );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const created = JSON.parse(first.stdout) as { id: string; created: boolean };
    assert.equal(created.created, true);
    assert.match(created.id, /^[a-f0-9-]{36}$/);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), { ...created, created: false });
    const config = getProjectIdentity(dir);
    assert.equal(config?.id, created.id);
    assert.match(readFileSync(join(dir, ".kit.toml"), "utf8"), /\[tools\]\nnode = "22"/);
  },
);

it("refuses identity publication when a TOML string mimics a memory table", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kit-project-identity-string-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, ".kit.toml");
  const original = 'version = 1\nmessage = """\n[memory]\n"""\n';
  writeFileSync(path, original);

  assert.throws(() => initializeProjectIdentity(dir), /project identity|memory\.project_id/i);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(getProjectIdentity(dir), null);
});
