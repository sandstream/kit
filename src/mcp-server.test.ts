import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";

// Standard .gitignore so security check passes in temp dirs
const GITIGNORE = ".env\n.env.local\n.env.*.local\n";

const FIXTURE_EMPTY = `# empty kit config\n`;

const FIXTURE_CONFIG_SECRET = `
[secrets.keys]
APP_KEY = { source = "config", value = "hello" }
`;

const FIXTURE_MISSING_ENV_SECRET = `
[secrets.keys]
MISSING_VAR = { source = "env" }
`;

const FIXTURE_NODE_TOOL = `
[tools]
node = "latest"
`;

/**
 * Create a connected Client + McpServer pair using in-memory transport.
 * Returns the client (already connected) and a cleanup function.
 */
async function createTestClient(): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

/** Parse JSON content from an MCP tool result */
function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.ok(content.length > 0, "Expected content in result");
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}

// ─── Tool registration ────────────────────────────────────────────────────────

describe("MCP server tool registration", () => {
  it("registers all tools", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      assert.ok(names.includes("kit_check"), "kit_check missing");
      assert.ok(names.includes("kit_install"), "kit_install missing");
      assert.ok(names.includes("kit_login"), "kit_login missing");
      assert.ok(names.includes("kit_secrets"), "kit_secrets missing");
      assert.ok(names.includes("kit_fix"), "kit_fix missing");
      assert.ok(names.includes("kit_add"), "kit_add missing");
      assert.ok(names.includes("kit_env"), "kit_env missing");
      assert.ok(names.includes("kit_init"), "kit_init missing");
      assert.ok(names.includes("kit_ci"), "kit_ci missing");
      assert.ok(names.includes("kit_run"), "kit_run missing");
      assert.ok(names.includes("kit_context"), "kit_context missing");
      assert.ok(names.includes("kit_configure"), "kit_configure missing");
      assert.ok(names.includes("kit_adapter_check"), "kit_adapter_check missing");
      assert.ok(names.includes("kit_adapter_install"), "kit_adapter_install missing");
      assert.ok(names.includes("kit_agent_governance"), "kit_agent_governance missing");
      assert.ok(names.includes("kit_skill_marketplace"), "kit_skill_marketplace missing");
      assert.ok(names.includes("kit_workflow_execute"), "kit_workflow_execute missing");
      assert.equal(tools.length, 17);
    } finally {
      await cleanup();
    }
  });
});

// ─── kit_check ─────────────────────────────────────────────────────────────

describe("kit_check", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-check-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns zero tools and secrets with empty config", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_check", arguments: { cwd: tempDir } });
      // ok depends on repo-level security checks — test structure, not ok
      const data = parseResult(result) as { ok: boolean; tools: unknown[]; secrets: unknown[] };
      assert.equal(data.tools.length, 0);
      assert.equal(data.secrets.length, 0);
    } finally {
      await cleanup();
    }
  });

  it("reports config-source secret as available", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_CONFIG_SECRET, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_check", arguments: { cwd: tempDir } });
      const data = parseResult(result) as { secrets: Array<{ name: string; available: boolean }> };
      // The secret itself is correct regardless of security check results
      assert.equal(data.secrets[0].name, "APP_KEY");
      assert.equal(data.secrets[0].available, true);
    } finally {
      await cleanup();
    }
  });

  it("returns ok:false when a required env secret is missing", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_MISSING_ENV_SECRET, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_check", arguments: { cwd: tempDir } });
      const data = parseResult(result) as {
        ok: boolean;
        secrets: Array<{ name: string; available: boolean }>;
      };
      assert.equal(data.ok, false);
      assert.equal(data.secrets[0].name, "MISSING_VAR");
      assert.equal(data.secrets[0].available, false);
    } finally {
      await cleanup();
    }
  });

  it("result includes tools, secrets, security, locks keys", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_check", arguments: { cwd: tempDir } });
      const data = parseResult(result) as Record<string, unknown>;
      assert.ok("ok" in data);
      assert.ok("tools" in data);
      assert.ok("secrets" in data);
      assert.ok("security" in data);
      assert.ok("locks" in data);
    } finally {
      await cleanup();
    }
  });
});

// ─── kit_fix ───────────────────────────────────────────────────────────────

describe("kit_fix", () => {
  let tempDir: string;
  let originalCwd: string;

  // Lock functions use process.cwd() — chdir to temp dir for isolation
  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-fix-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE, "utf-8");
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns ok:true and generates lock files", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_fix", arguments: {} });
      const data = parseResult(result) as {
        ok: boolean;
        actions: Array<{ name: string; action: string }>;
      };
      assert.equal(data.ok, true);
      const names = data.actions.map((a) => a.name);
      assert.ok(names.includes("skills-lock.json"), "skills-lock.json not generated");
      assert.ok(names.includes("cli-lock.json"), "cli-lock.json not generated");
    } finally {
      await cleanup();
    }
  });

  it("returns ok:true with no actions when lock files already exist", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const { client: c1, cleanup: cl1 } = await createTestClient();
    try {
      await c1.callTool({ name: "kit_fix", arguments: {} });
    } finally {
      await cl1();
    }
    // Run fix again — lock files already exist
    const { client: c2, cleanup: cl2 } = await createTestClient();
    try {
      const result = await c2.callTool({ name: "kit_fix", arguments: {} });
      const data = parseResult(result) as { ok: boolean; actions: unknown[] };
      assert.equal(data.ok, true);
      assert.equal(data.actions.length, 0);
    } finally {
      await cl2();
    }
  });
});

// ─── kit_add ───────────────────────────────────────────────────────────────

describe("kit_add", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-add-"));
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns success:false and error for unknown service", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_add",
        arguments: { service: "nonexistent-service-xyz", cwd: tempDir },
      });
      const data = parseResult(result) as { success: boolean; error?: string };
      assert.equal(data.success, false);
      assert.ok(
        data.error?.includes("Unknown service"),
        `Expected unknown service error, got: ${data.error}`,
      );
    } finally {
      await cleanup();
    }
  });
});

// ─── kit_login ─────────────────────────────────────────────────────────────

describe("kit_login", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-login-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
    delete process.env.KIT_NON_INTERACTIVE;
  });

  it("returns no results when no services configured", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_login", arguments: { cwd: tempDir } });
      const data = parseResult(result) as { results: unknown[]; message: string };
      assert.equal(data.results.length, 0);
      assert.ok(data.message.includes("No services"));
    } finally {
      await cleanup();
    }
  });

  it("sets KIT_NON_INTERACTIVE to prevent TTY hang", async () => {
    delete process.env.KIT_NON_INTERACTIVE;
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      await client.callTool({ name: "kit_login", arguments: { cwd: tempDir } });
      assert.equal(process.env.KIT_NON_INTERACTIVE, "1");
    } finally {
      await cleanup();
    }
  });
});

// ─── kit_secrets ──────────────────────────────────────────────────────────

describe("kit_secrets", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-secrets-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns no written keys when no secrets configured", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_secrets", arguments: { cwd: tempDir } });
      const data = parseResult(result) as { written: unknown[]; message: string };
      assert.ok(data.message.includes("No secrets"));
    } finally {
      await cleanup();
    }
  });

  it("resolves config-source secrets and returns written keys", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_CONFIG_SECRET, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_secrets", arguments: { cwd: tempDir } });
      const data = parseResult(result) as { ok: boolean; writtenKeys: string[] };
      assert.equal(data.ok, true);
      assert.ok(data.writtenKeys.includes("APP_KEY"));
    } finally {
      await cleanup();
    }
  });
});

// ─── kit_install ───────────────────────────────────────────────────────────

describe("kit_install", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-install-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns no-op message when no tools configured", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_install", arguments: { cwd: tempDir } });
      const data = parseResult(result) as { message: string };
      assert.ok(data.message.includes("No tools"));
    } finally {
      await cleanup();
    }
  });

  it("returns ok:true when node is already installed at latest", async () => {
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_NODE_TOOL, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_install", arguments: { cwd: tempDir } });
      const data = parseResult(result) as {
        ok: boolean;
        results: Array<{ name: string; action: string }>;
      };
      assert.equal(data.ok, true);
      const node = data.results.find((r) => r.name === "node");
      assert.ok(node, "node not in results");
      assert.equal(node.action, "already_ok");
    } finally {
      await cleanup();
    }
  });
});

// ─── kit_env ───────────────────────────────────────────────────────────────

describe("kit_env", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-env-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE, "utf-8");
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns envLocalExists=false when .env.local is missing", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_env", arguments: { cwd: tempDir } });
      const data = parseResult(result) as { ok: boolean; keys: unknown[]; envLocalExists: boolean };
      assert.equal(data.envLocalExists, false);
    } finally {
      await cleanup();
    }
  });

  it("returns keys from .env.local with redacted values", async () => {
    await writeFile(join(tempDir, ".env.local"), "SECRET=sk-abcdefghij\n", "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_env", arguments: { cwd: tempDir } });
      const data = parseResult(result) as {
        ok: boolean;
        keys: Array<{ name: string; set: boolean; redacted?: string; value?: string }>;
        envLocalExists: boolean;
      };
      assert.equal(data.envLocalExists, true);
      const key = data.keys.find((k) => k.name === "SECRET");
      assert.ok(key, "SECRET key not found");
      assert.equal(key.set, true);
      assert.ok(key.redacted, "value should be redacted by default");
      assert.equal(key.value, undefined, "raw value should not be exposed by default");
    } finally {
      await cleanup();
    }
  });

  it("returns actual value when show_values=true", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_env",
        arguments: { cwd: tempDir, show_values: true },
      });
      const data = parseResult(result) as {
        keys: Array<{ name: string; value?: string }>;
      };
      const key = data.keys.find((k) => k.name === "SECRET");
      assert.ok(key, "SECRET key not found");
      assert.equal(key.value, "sk-abcdefghij");
    } finally {
      await cleanup();
    }
  });

  it("returns only missing keys when missing_only=true", async () => {
    const configWithMissing = `
[secrets.keys]
SECRET = { source = "env" }
MISSING_KEY = { source = "env" }
`;
    await writeFile(join(tempDir, ".kit.toml"), configWithMissing, "utf-8");
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_env",
        arguments: { cwd: tempDir, missing_only: true },
      });
      const data = parseResult(result) as {
        keys: Array<{ name: string; set: boolean }>;
      };
      assert.ok(
        data.keys.every((k) => !k.set),
        "missing_only should only return unset keys",
      );
      assert.ok(
        data.keys.some((k) => k.name === "MISSING_KEY"),
        "MISSING_KEY should be in result",
      );
      assert.ok(
        !data.keys.some((k) => k.name === "SECRET"),
        "SECRET is set — should not appear with missing_only",
      );
    } finally {
      await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
      await cleanup();
    }
  });
});

// ─── kit_init ──────────────────────────────────────────────────────────────

describe("kit_init", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-init-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE, "utf-8");
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns detectedStack and generatedConfig", async () => {
    // Use a project dir with a package.json so detection has something to work with
    const projectDir = join(tempDir, "nextjs-proj");
    await mkdtemp(projectDir).catch(() => null);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_init",
        arguments: { cwd: projectDir, dry_run: true },
      });
      const data = parseResult(result) as {
        detectedStack: { language: string; framework?: string };
        generatedConfig: string;
        written: boolean;
        alreadyExists: boolean;
      };
      assert.equal(data.detectedStack.language, "typescript");
      assert.equal(data.detectedStack.framework, "nextjs");
      assert.ok(
        data.generatedConfig.includes("[tools]"),
        `expected [tools]: ${data.generatedConfig}`,
      );
      assert.equal(data.written, false, "dry_run=true should not write");
    } finally {
      await cleanup();
    }
  });

  it("dry_run=true does not create .kit.toml", async () => {
    const projectDir = join(tempDir, "dryrun-proj");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    const { client, cleanup } = await createTestClient();
    try {
      await client.callTool({
        name: "kit_init",
        arguments: { cwd: projectDir, dry_run: true },
      });

      // File should NOT have been created
      let fileExists = false;
      try {
        await rm(join(projectDir, ".kit.toml"), { force: false });
        fileExists = true;
      } catch {
        fileExists = false;
      }
      assert.equal(fileExists, false, "dry_run should not write .kit.toml");
    } finally {
      await cleanup();
    }
  });

  it("dry_run=false writes .kit.toml", async () => {
    const projectDir = join(tempDir, "write-proj");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_init",
        arguments: { cwd: projectDir, dry_run: false },
      });
      const data = parseResult(result) as { written: boolean };
      assert.equal(data.written, true, "dry_run=false should write file");

      // File should exist
      const content = await readFile(join(projectDir, ".kit.toml"), "utf-8");
      assert.ok(content.length > 0, ".kit.toml should have content");
    } finally {
      await cleanup();
    }
  });

  it("does not overwrite existing .kit.toml", async () => {
    const projectDir = join(tempDir, "existing-proj");
    await mkdir(projectDir, { recursive: true });
    const original = '# existing\n[tools]\nnode = "18"\n';
    await writeFile(join(projectDir, ".kit.toml"), original, "utf-8");
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );

    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_init",
        arguments: { cwd: projectDir, dry_run: false },
      });
      const data = parseResult(result) as { written: boolean; alreadyExists: boolean };
      assert.equal(data.alreadyExists, true);
      assert.equal(data.written, false, "should not overwrite existing config");

      const content = await readFile(join(projectDir, ".kit.toml"), "utf-8");
      assert.equal(content, original, "original content should be unchanged");
    } finally {
      await cleanup();
    }
  });
});
