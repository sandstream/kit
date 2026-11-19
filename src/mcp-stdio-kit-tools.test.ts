import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer, KIT_MCP_TOOLS } from "./mcp-server.js";
import { StdioMcpServer, type ToolConfig } from "./mcp-stdio.js";
import {
  ask,
  handshake,
  ownWireFor,
  sdkWireFor,
  type Msg,
  type Registrar,
  type Wire,
} from "./mcp-stdio.test-support.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

/**
 * The ten real kit tools, served by the SDK and by kit's own stdio server.
 *
 * `createMcpServer` is the real server and builds the own one. The SDK side is built from the
 * registrations of the real server, so each tool keeps its real schema, description and handler.
 */

interface Registered {
  config: ToolConfig;
  handler: (...args: never[]) => unknown;
}

const registrations = (s: StdioMcpServer): [string, Registered][] => [
  ...(s as unknown as { tools: Map<string, Registered> }).tools,
];

/** Both servers, built from the same registrations. */
async function kitWires(): Promise<{ sdk: Wire; own: Wire }> {
  const own = createMcpServer();
  const sdk = new McpServer(
    { name: "kit", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: (own as unknown as { options: { instructions?: string } }).options.instructions,
    },
  );
  for (const [name, t] of registrations(own)) {
    (sdk as unknown as Registrar).registerTool(name, t.config as never, t.handler as never);
  }
  return { sdk: await sdkWireFor(sdk), own: await ownWireFor(createMcpServer()) };
}

/** What kit_check says that does not change from one run to the next. */
function stable(message: Msg): unknown {
  const result = message.result as { content?: { text?: string }[]; isError?: boolean };
  const text = result?.content?.[0]?.text ?? "";
  try {
    const { ok, scope, counts, failed } = JSON.parse(text);
    return { isError: result.isError, ok, scope, counts, failed };
  } catch {
    return { isError: result?.isError, text };
  }
}

describe("kit's ten tools through the SDK server and the own stdio server", () => {
  let dir = "";
  let wires: { sdk: Wire; own: Wire };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "kit-stdio-tools-"));
    writeFileSync(join(dir, ".gitignore"), ".env\n.env.local\n.env.*.local\n");
    writeFileSync(join(dir, ".kit.toml"), "# empty kit config\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), 'import { b } from "./b.js";\nexport const a = b;\n');
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
    wires = await kitWires();
    await handshake(wires.sdk);
    await handshake(wires.own);
  });

  after(async () => {
    await wires.sdk.close();
    await wires.own.close();
    rmTemp(dir);
  });

  const both = async (name: string, args: Msg, id: number): Promise<{ sdk: Msg; own: Msg }> => ({
    sdk: await ask(wires.sdk, "tools/call", { name, arguments: args }, id),
    own: await ask(wires.own, "tools/call", { name, arguments: args }, id),
  });

  it("lists all ten with the same schemas", async () => {
    const sdk = await ask(wires.sdk, "tools/list", {}, 2);
    const own = await ask(wires.own, "tools/list", {}, 2);
    assert.deepEqual(own, sdk);
    const names = (own.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.deepEqual(names, [...KIT_MCP_TOOLS], "same tools in the same order");
  });

  it("refuses bad arguments on every tool with the same text", async () => {
    // Every tool has an argument of the wrong type or a missing required one, so no handler runs.
    const bad: [string, Msg][] = [
      ["kit_check", { detail: "yes" }],
      ["kit_review", { enforce: "yes" }],
      ["kit_secrets", { cwd: 5 }],
      ["kit_fix", { cwd: 5 }],
      ["kit_init", { dry_run: "yes" }],
      ["kit_run", {}],
      ["kit_context", { cwd: 5 }],
      ["kit_map", {}],
      ["kit_triage", { type: "nope" }],
      ["kit_memory", {}],
    ];
    let id = 100;
    for (const [name, args] of bad) {
      const { sdk, own } = await both(name, args, id++);
      assert.deepEqual(own, sdk, name);
      assert.equal((own.result as { isError?: boolean }).isError, true, name);
    }
  });

  it("returns the same answer from the tools that read a project", async () => {
    const calls: [string, Msg][] = [
      ["kit_context", { cwd: dir }],
      ["kit_map", { paths: ["src/a.ts"], cwd: dir }],
      ["kit_init", { dry_run: true, cwd: dir }],
    ];
    let id = 200;
    for (const [name, args] of calls) {
      const { sdk, own } = await both(name, args, id++);
      assert.deepEqual(own, sdk, name);
    }
  });

  it("returns the same verdict from kit_check", async () => {
    const { sdk, own } = await both("kit_check", { cwd: dir }, 300);
    assert.deepEqual(stable(own), stable(sdk));
  });
});
