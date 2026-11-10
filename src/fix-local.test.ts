import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";
import { checkGitignore } from "./check-gitignore.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const CONFIG = `[secrets]
template = ".env.template"
[secrets.keys.API_KEY]
source = "env"
`;

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-mcp-fix-files-"));
  const host = join(root, "host");
  const target = join(root, "target");
  const previousCwd = process.cwd();
  const environment = {
    KIT_IDENTITY_DIR: join(root, "identity"),
    KIT_MEMORY_DB: join(root, "memory.db"),
    KIT_MEMORY_DIR: join(root, "memory"),
    KIT_READ_ONLY: undefined,
  };
  const previous = Object.keys(environment).map((key) => [key, process.env[key]] as const);
  const server = createMcpServer();
  const client = new Client({ name: "fix-files-test", version: "1" });
  t.after(async () => {
    try {
      await client.close();
      await server.close();
    } finally {
      process.chdir(previousCwd);
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmTemp(root);
    }
  });
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const path of [host, target]) {
    mkdirSync(path);
    execFileSync("git", ["init", "-q", path]);
    writeFileSync(join(path, ".kit.toml"), CONFIG);
    writeFileSync(join(path, ".gitignore"), "node_modules\n");
  }
  process.chdir(host);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  async function fix(cwd = "../target") {
    const result = await client.callTool({ name: "kit_fix", arguments: { cwd } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const content = result.content as Array<{ text: string }>;
    return JSON.parse(content[0].text) as {
      ok: boolean;
      actions: Array<{ name: string; action: string; detail: string }>;
    };
  }
  return { host, target, fix, client };
}

it("MCP fix writes and verifies target files, preserves the host, and repeats without changes", async (t) => {
  const { host, target, fix } = await fixture(t);
  writeFileSync(join(host, ".env.template"), "HOST_ONLY=\n");
  const result = await fix();
  assert.equal(result.ok, true);
  assert.ok(result.actions.some((a) => a.name === ".env.template" && a.action === "generated"));
  assert.ok(result.actions.some((a) => a.name === ".gitignore" && a.action === "fixed"));
  assert.match(readFileSync(join(target, ".env.template"), "utf8"), /^API_KEY=$/m);
  assert.equal((await checkGitignore(target)).missingPatterns.length, 0);
  assert.ok(existsSync(join(target, ".kit", "skills-lock.json")));
  assert.equal(existsSync(join(host, ".kit", "skills-lock.json")), false);
  assert.equal(readFileSync(join(host, ".gitignore"), "utf8"), "node_modules\n");
  assert.equal(readFileSync(join(host, ".env.template"), "utf8"), "HOST_ONLY=\n");
  const before = readFileSync(join(target, ".gitignore"), "utf8");
  writeFileSync(join(target, ".env.template"), "KEEP_THIS=\n");
  assert.deepEqual(await fix(), { ok: true, actions: [] });
  assert.equal(readFileSync(join(target, ".gitignore"), "utf8"), before);
  assert.equal(readFileSync(join(target, ".env.template"), "utf8"), "KEEP_THIS=\n");
});

it("MCP fix reports template errors while completing independent repairs", async (t) => {
  const { target, fix } = await fixture(t);
  writeFileSync(
    join(target, ".kit.toml"),
    CONFIG.replace(".env.template", "missing/.env.template"),
  );
  const result = await fix();
  assert.equal(result.ok, false);
  assert.ok(
    result.actions.some((a) => a.name === "missing/.env.template" && a.action === "failed"),
  );
  assert.equal((await checkGitignore(target)).missingPatterns.length, 0);
});

it("MCP fix reports unverified ignore protection instead of returning success", async (t) => {
  const { target, fix } = await fixture(t);
  rmTemp(join(target, ".git"));
  const result = await fix();
  assert.equal(result.ok, false);
  assert.ok(result.actions.some((a) => a.name === ".gitignore" && a.action === "failed"));
});

it("MCP fix refuses all file repairs in read-only mode", async (t) => {
  const { target, client } = await fixture(t);
  process.env.KIT_READ_ONLY = "1";
  const result = await client.callTool({ name: "kit_fix", arguments: { cwd: target } });
  assert.equal(result.isError, true);
  assert.equal(existsSync(join(target, ".env.template")), false);
  assert.equal(existsSync(join(target, ".kit", "skills-lock.json")), false);
  assert.equal(readFileSync(join(target, ".gitignore"), "utf8"), "node_modules\n");
});

it("MCP fix records governance evidence in the target project", async (t) => {
  const { host, target, fix } = await fixture(t);
  writeFileSync(
    join(target, ".kit.toml"),
    `${CONFIG}\n[governance]\nenabled = true\n[governance.audit]\nenabled = true\n`,
  );
  assert.equal((await fix()).ok, true);
  assert.match(readFileSync(join(target, ".kit-audit.jsonl"), "utf8"), /"operation":\s*"fix"/);
  assert.equal(existsSync(join(host, ".kit-audit.jsonl")), false);
});
