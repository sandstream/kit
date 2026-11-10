import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { kitConfig } from "./config.js";

export const governanceConfig: kitConfig = {
  governance: {
    enabled: true,
    environment: "dev",
    audit: { enabled: true, remote: false },
    agent: { max_tokens_per_day: 100, max_operations_per_hour: 2 },
    revocation: { enabled: false },
    secrets: { check_expiration: false },
  },
};

export const projectConfig = `[governance]
enabled = true
environment = "dev"
[governance.agent]
max_tokens_per_day = 100
max_operations_per_hour = 2
[governance.audit]
enabled = true
remote = false
[governance.revocation]
enabled = false
[governance.secrets]
check_expiration = false
`;

/** Use only temporary project state, identity, audit anchors, HOME, and PAL storage. */
export function governanceFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-governance-outcome-"));
  const host = join(root, "host");
  const target = join(root, "target");
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  t.after(async () => {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnv);
    await rm(root, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("KIT_") || key.startsWith("GIT_")) delete process.env[key];
  }
  Object.assign(process.env, {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home", ".config"),
    KIT_IDENTITY_DIR: join(root, "identity"),
    KIT_KEYSTORE: "file",
    KIT_AUDIT_ANCHOR: "0",
    KIT_AUDIT_ANCHOR_DIR: join(root, "anchors"),
    KIT_MEMORY_DIR: join(root, "memory"),
    KIT_MEMORY_DB: join(root, "memory", "memory.db"),
    KIT_PAL_LEDGER: join(root, "pal", "ledger.jsonl"),
    KIT_DEFAULTS_FILE: join(root, "defaults.toml"),
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  });
  for (const path of [process.env.HOME!, host, target]) mkdirSync(path, { recursive: true });
  for (const path of [host, target]) {
    execFileSync("git", ["init", "-q", path]);
    writeFileSync(join(path, ".kit.toml"), projectConfig);
    writeFileSync(join(path, ".gitignore"), "node_modules\n");
  }
  process.chdir(host);
  return { root, host, target };
}

export function seedBudget(cwd: string, tokens: number, operations: number): string {
  const now = new Date().toISOString();
  const contents = JSON.stringify({
    tokens_today: tokens,
    operations_this_hour: operations,
    last_token_reset: now,
    last_operation_reset: now,
  });
  writeFileSync(join(cwd, ".kit-budget.json"), contents);
  return contents;
}

export function budgetContents(cwd: string): string | undefined {
  const path = join(cwd, ".kit-budget.json");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export async function governanceClient(t: TestContext) {
  const { createMcpServer } = await import("./mcp-server.js");
  const server = createMcpServer();
  const client = new Client({ name: "governance-outcome-test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

export async function callFix(client: Client, cwd: string) {
  const result = await client.callTool({ name: "kit_fix", arguments: { cwd } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0].text) as {
    ok: boolean;
    actions: Array<{ name: string; action: string; detail: string }>;
  };
}
