import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";

/** Every database and command runs under a temporary HOME and memory directory. */
export async function captureFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-insight-capture-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const path = join(root, "memory", "memory.db");
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const state: { db?: DatabaseSync } = {};
  t.after(() => {
    try {
      state.db?.close();
    } finally {
      process.chdir(originalCwd);
      process.argv = originalArgv;
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      rmSync(root, { recursive: true, force: true });
    }
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("KIT_")) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    KIT_MEMORY_DB: path,
    KIT_MEMORY_DIR: join(root, "memory"),
    KIT_PAL_LEDGER: join(root, "pal", "ledger.jsonl"),
    KIT_IDENTITY_DIR: join(root, "identity"),
    KIT_KEYSTORE: "file",
    KIT_AUDIT_ANCHOR: "0",
    KIT_AUDIT_ANCHOR_DIR: join(root, "anchors"),
    KIT_DEFAULTS_FILE: join(root, "defaults.toml"),
  });
  mkdirSync(home);
  mkdirSync(project);
  process.chdir(project);
  const { openMemoryDb } = await import("../memory/db.js");
  state.db = openMemoryDb(path);
  return { db: state.db, root, project, path };
}

export function addMessage(
  db: DatabaseSync,
  uuid: string,
  version = 1,
  session = "session",
  expectedCalls: number | null = version === 1 ? 0 : null,
) {
  db.prepare(
    "INSERT INTO messages (uuid, session_id, type, tool_capture_version, tool_capture_count) VALUES (?, ?, 'assistant', ?, ?)",
  ).run(uuid, session, version, expectedCalls);
}

export function addCall(
  db: DatabaseSync,
  uuid: string,
  name: string,
  input = "{}",
  outcome = "unknown",
) {
  db.prepare(
    "INSERT INTO tool_uses (message_uuid, session_id, tool_name, tool_input, call_id, outcome) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(uuid, "session", name, input, `${uuid}:${name}`, outcome);
}

export function loadedFixture(project: string) {
  writeFileSync(
    join(project, ".mcp.json"),
    JSON.stringify({
      mcpServers: { referenced: { command: "fixture" }, missing: { command: "fixture" } },
    }),
  );
  for (const skill of ["referenced-skill", "missing-skill"]) {
    const directory = join(project, ".claude", "skills", skill);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), "Fixture skill.\n");
  }
}
