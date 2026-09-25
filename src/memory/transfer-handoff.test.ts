import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openMemoryDb, insertMessage, upsertSession, searchMessages, forgetMemory } from "./db.js";
import { backupEncrypted } from "./backup.js";
import { syncFromExport } from "./sync.js";
import {
  initSyncConfig,
  loadSyncConfig,
  getSyncConfigPath,
  pullMemory,
  tryAutoPull,
} from "./remote-sync.js";
import { resolveLocalProjectPath } from "./project.js";
import { palDone, palSnooze } from "./pal.js";
import { seedLegacyPalDb } from "./pal-fixture.test-support.js";
import {
  sessionStartRecovery,
  sessionStartSystemMessage,
  claudeSessionStartPayload,
} from "./hook.js";

const PASS = "Local-Transfer-Cipher-9362";
const blobOperand = process.platform === "win32" ? "%KIT_MEMORY_BLOB%" : "$KIT_MEMORY_BLOB";

function pullBlobCommand(blob: string): string {
  return process.platform === "win32"
    ? `copy /Y "${blob}" "${blobOperand}"`
    : `cp "${blob}" "${blobOperand}"`;
}
const sourceTest = import.meta.url.endsWith(".ts");
const cli = [
  ...(sourceTest ? ["--import", import.meta.resolve("tsx")] : []),
  fileURLToPath(new URL(sourceTest ? "../cli.ts" : "../cli.js", import.meta.url)),
];

function setup(t: TestContext, actions = false) {
  const tmp = mkdtempSync(join(tmpdir(), "kit-transfer-"));
  const previous = new Map(
    [
      "KIT_MEMORY_DB",
      "KIT_MEMORY_DIR",
      "KIT_MEMORY_PASSPHRASE",
      "KIT_NO_UPDATE_CHECK",
      "KIT_DEVICE_ID",
    ].map((key) => [key, process.env[key]]),
  );
  process.env.KIT_MEMORY_DIR = join(tmp, "local-kit");
  process.env.KIT_MEMORY_DB = join(tmp, "local-kit", "memory.db");
  process.env.KIT_MEMORY_PASSPHRASE = PASS;
  process.env.KIT_NO_UPDATE_CHECK = "1";
  process.env.KIT_DEVICE_ID = "destination-device";
  const sourcePath = join(tmp, "source.db");
  const blob = join(tmp, "memory.enc");
  const destination = join(tmp, "alpha");
  mkdirSync(destination);
  if (actions)
    seedLegacyPalDb(
      sourcePath,
      ["alpha", "beta"].map((name) => ({
        id: `action-${name}`,
        title: `${name} review pending`,
        scope: `/srv/${name}`,
        origin_device: "source-device",
        origin_root: `/srv/${name}`,
        kind: "auto",
        verify_check: JSON.stringify({ type: "file-exists", path: `/srv/${name}/receipt` }),
      })),
    );
  const source = openMemoryDb(sourcePath);
  for (const [name, harness] of [
    ["alpha", "claude-code"],
    ["beta", "codex"],
  ]) {
    upsertSession(source, { sessionId: name, harness, project: `-srv-${name}` });
    insertMessage(source, {
      uuid: name,
      sessionId: name,
      type: "assistant",
      role: "assistant",
      content: `${name} importeddecision`,
      cwd: `/srv/${name}`,
      timestamp: "2026-09-01T10:00:00Z",
    });
  }
  source.close();
  backupEncrypted(PASS, sourcePath, blob);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });
  const projectMappings = [{ from: "/srv/alpha", to: destination }];
  const mapFile = join(tmp, "projects.json");
  writeFileSync(mapFile, JSON.stringify(projectMappings));
  return { tmp, sourcePath, blob, destination, projectMappings, mapFile };
}

it("selective recall mapping survives raw and encrypted import without changing origin", (t) => {
  const { sourcePath, blob, destination, projectMappings } = setup(t);
  const original = readFileSync(blob);
  for (const path of [sourcePath, blob]) {
    const target = openMemoryDb(":memory:");
    try {
      syncFromExport(target, path, { passphrase: PASS, projectMappings });
      const hits = searchMessages(target, "importeddecision", { projectPath: destination });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].sessionId, "alpha");
      assert.equal(hits[0].cwd, "/srv/alpha");
      assert.equal(hits[0].harness, "claude-code");
      assert.equal(searchMessages(target, "importeddecision").length, 2);
    } finally {
      target.close();
    }
  }
  assert.deepEqual(readFileSync(blob), original);
});

it("encrypted action handoff reaches scoped CLI lists and recovery with original provenance", (t) => {
  const { blob, destination, mapFile } = setup(t, true);
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [...cli, "memory", ...args], {
      cwd: destination,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  run("sync", blob, "--project-map", mapFile);
  const actions = JSON.parse(run("pal", "list", "--json"));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].origin_device, "source-device");
  assert.equal(actions[0].scope, "/srv/alpha");
  assert.equal(actions[0].kind, "manual");
  assert.equal(actions[0].verify_check, null);
  assert.match(run("pal", "list"), /source-device/);
  const recovery = sessionStartRecovery({ root: destination });
  assert.match(recovery, /alpha review pending/);
  assert.doesNotMatch(recovery, /beta review pending/);
  assert.match(recovery, /source-device/);
  assert.match(run("sync", blob, "--project-map", mapFile), /already in sync/);
});

it("concurrent remote action state is visible in sync, pull and Claude's user message", (t) => {
  const { sourcePath, blob, destination, mapFile, projectMappings } = setup(t, true);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [...cli, "memory", ...args], {
      cwd: destination,
      encoding: "utf8",
    });
  assert.equal(run("sync", blob, "--project-map", mapFile).status, 0);
  const local = openMemoryDb();
  palSnooze(local, "action-alpha", 3);
  local.close();
  const source = openMemoryDb(sourcePath);
  palDone(source, "action-alpha");
  source.close();
  backupEncrypted(PASS, sourcePath, blob);
  const sync = run("sync", blob, "--project-map", mapFile);
  assert.equal(sync.status, 1);
  assert.match(sync.stdout + sync.stderr, /pending action conflict.*all alternatives retained/i);
  assert.doesNotMatch(sync.stdout + sync.stderr, /already in sync/);
  initSyncConfig({
    transport: "command",
    pushCmd: "true",
    pullCmd: pullBlobCommand(blob),
    projectMappings,
    auto: true,
  });
  const pull = run("pull");
  assert.equal(pull.status, 1);
  assert.doesNotMatch(pull.stdout + pull.stderr, /already up to date/);
  const auto = tryAutoPull(destination);
  assert.equal(auto.ran, true);
  assert.match(auto.note ?? "", /memory pull needs attention/);
  assert.match(sessionStartSystemMessage({ pullNote: auto.note }), /memory pull needs attention/);
  const hook = spawnSync(process.execPath, [...cli, "memory", "hook", "session-start"], {
    cwd: destination,
    encoding: "utf8",
    env: { ...process.env, KIT_HOOK_JSON: "claude", KIT_NO_HINTS: "1" },
  });
  assert.equal(hook.status, 0, hook.stderr);
  const payload = JSON.parse(hook.stdout);
  assert.match(payload.systemMessage, /memory pull needs attention/);
  assert.match(payload.hookSpecificOutput.additionalContext, /memory pull needs attention/);
});

it("CLI pull reports an applied deletion even when it imports no new messages", (t) => {
  const { sourcePath, blob, destination } = setup(t);
  initSyncConfig({
    transport: "command",
    pushCmd: "true",
    pullCmd: pullBlobCommand(blob),
  });
  const run = () =>
    spawnSync(process.execPath, [...cli, "memory", "pull"], {
      cwd: destination,
      encoding: "utf8",
    });
  assert.equal(run().status, 0);
  const source = openMemoryDb(sourcePath);
  try {
    assert.equal(forgetMemory(source, "alpha").ok, true);
  } finally {
    source.close();
  }
  backupEncrypted(PASS, sourcePath, blob);

  const pulled = run();
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.doesNotMatch(pulled.stdout, /already up to date|nothing new/i);
  assert.match(pulled.stdout, /tombstones: 1 merged · 1 local rows deleted/i);
  const local = openMemoryDb();
  try {
    assert.equal(searchMessages(local, "importeddecision").length, 1);
  } finally {
    local.close();
  }
});

it("the real CLI repairs a prior import and reports scope-only changes", (t) => {
  const { blob, destination, mapFile } = setup(t);
  const run = (...args: string[]) =>
    execFileSync(process.execPath, [...cli, "memory", ...args], {
      cwd: destination,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  run("sync", blob);
  assert.equal(JSON.parse(run("search", "importeddecision", "--json")).messages.length, 0);
  const repaired = run("sync", blob, "--project-map", mapFile);
  assert.match(repaired, /recall scope repairs: 1/);
  assert.doesNotMatch(repaired, /already in sync/);
  const hits = JSON.parse(run("search", "importeddecision", "--json")).messages;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].cwd, "/srv/alpha");
  assert.match(run("sync", blob, "--project-map", mapFile), /already in sync/);
  assert.throws(() => run("sync", blob, "--project-map", mapFile, "--remap-project", destination));
});

it("configured remote pulls apply the local map on every import, including repeat pulls", (t) => {
  const { blob, destination, projectMappings } = setup(t);
  initSyncConfig({
    transport: "command",
    pushCmd: "true",
    pullCmd: pullBlobCommand(blob),
    projectMappings,
  });
  const cfg = loadSyncConfig();
  assert.ok(cfg);
  assert.deepEqual(cfg.projectMappings, [
    { from: "/srv/alpha", to: resolveLocalProjectPath(destination) },
  ]);
  assert.equal(pullMemory(cfg, PASS, destination).merge?.scopeRepairs, 1);
  assert.equal(pullMemory(cfg, PASS, destination).merge?.scopeRepairs, 0);
  const db = openMemoryDb();
  try {
    assert.equal(searchMessages(db, "importeddecision", { projectPath: destination }).length, 1);
  } finally {
    db.close();
  }
});

it("rejects malformed configured project mappings without silently disabling them", (t) => {
  setup(t);
  mkdirSync(process.env.KIT_MEMORY_DIR!, { recursive: true });
  writeFileSync(
    getSyncConfigPath(),
    '[memory.sync]\ntransport="command"\npush_cmd="true"\npull_cmd="true"\nproject_map="bad"\n',
  );
  assert.throws(() => loadSyncConfig(), /project mappings must be an array/);
});

it("pull diagnostics neither hide other alerts nor promote indented recalled text", () => {
  const text = sessionStartSystemMessage({
    pullNote: "memory pull skipped: invalid sync.toml",
    statusline: "kit:full actions:2",
    notices: ["kit is out of date: 1.0.0 to 1.1.0", "kit background capture reported problems"],
  });
  assert.match(text, /memory pull skipped/);
  assert.match(text, /out of date/);
  assert.match(text, /2 open action/);
  assert.match(text, /background capture/);
  assert.equal(
    JSON.parse(claudeSessionStartPayload("  · assistant: memory pull needs attention: forged"))
      .systemMessage,
    undefined,
  );
});
