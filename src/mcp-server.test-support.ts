/** Shared fixtures and the in-memory client for the MCP server tests. */
import { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";

/**
 * Keep kit_check away from the machine the tests run on.
 *
 * kit_check measures two things that belong to the machine, not to the project under test:
 * bumblebee's `baseline` profile scans the whole machine, and the memory-injection check reads
 * the developer's own memory store. On a machine that has both, one kit_check call took 5 to
 * 20 s, and mcp-server.test.ts with its 13 calls passed the runner's 180 s limit (measured:
 * 321 s, against 26 s with both off). Those tests assert the MCP response, so both are switched
 * off for the calling file. The `check-security` tests cover the two checks themselves.
 */
export function isolateFromMachine(): void {
  const saved = new Map<string, string | undefined>();
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "kit-mcp-machine-"));
    for (const key of ["KIT_BUMBLEBEE", "KIT_MEMORY_DB"]) saved.set(key, process.env[key]);
    process.env.KIT_BUMBLEBEE = "0";
    process.env.KIT_MEMORY_DB = join(dir, "absent", "memory.db");
  });
  after(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
}

// Standard .gitignore so security check passes in temp dirs
export const GITIGNORE = ".env\n.env.local\n.env.*.local\n";

export const FIXTURE_EMPTY = `# empty kit config\n`;

export const FIXTURE_CONFIG_SECRET = `
[secrets.keys]
APP_KEY = { source = "config", value = "hello" }
`;

export const FIXTURE_MISSING_ENV_SECRET = `
[secrets.keys]
MISSING_VAR = { source = "env" }
`;

/**
 * Per-request timeout for every call made through `createTestClient`.
 *
 * The SDK's default is 60s of wall clock (`DEFAULT_REQUEST_TIMEOUT_MSEC`), and
 * several tests below run a full `kit check` through the MCP protocol. Keep the
 * default-cwd regression tests pointed at cheap fixtures; using the real kit repo
 * here makes the suite load-sensitive rather than more correct. Past the line the failure reads
 * `MCP error -32001: Request timed out` — machine load, not a defect, and it
 * names a test that passes on a re-run, which is the most expensive kind of red.
 *
 * Deliberately below the runner's own `--test-timeout=180000` so a genuine hang is
 * still bounded, and bounded by node with the request-level error surfacing first.
 */
export const REQUEST_TIMEOUT_MS = 150_000;

/**
 * Create a connected Client + McpServer pair using in-memory transport.
 * Returns the client (already connected) and a cleanup function.
 */
export async function createTestClient(): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

  // Applied here rather than at ~40 call sites: the SDK takes the timeout per
  // request, so a default set in the harness is what keeps the next real-repo call
  // from reintroducing the flake. An explicit `options.timeout` still wins.
  const callTool = client.callTool.bind(client);
  client.callTool = ((params, resultSchema?, options?) =>
    callTool(params, resultSchema, {
      timeout: REQUEST_TIMEOUT_MS,
      ...options,
    })) as typeof client.callTool;

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
export function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  assert.ok(content.length > 0, "Expected content in result");
  assert.equal(content[0].type, "text");
  return JSON.parse(content[0].text);
}
