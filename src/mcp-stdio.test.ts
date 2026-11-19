import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { StdioMcpServer } from "./mcp-stdio.js";
import {
  INFO,
  INSTRUCTIONS,
  ask,
  handshake,
  onBoth,
  ownWire,
  type Msg,
  type Registrar,
} from "./mcp-stdio.test-support.js";

/**
 * Conformance of kit's own stdio server against the MCP SDK's server.
 *
 * The SDK is a development dependency here. Every case builds the same tools on both servers,
 * sends the same JSON-RPC messages and compares what comes back. The SDK is the reference: a
 * difference is a defect in the new server unless a test below names it as chosen.
 */

function fixtureTools(s: Registrar): void {
  s.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Repeat the text.",
      inputSchema: {
        text: z.string().describe("what to repeat"),
        times: z.number().int().min(1).max(5).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ text, times }) => ({
      content: [{ type: "text" as const, text: text.repeat(times ?? 1) }],
    }),
  );
  s.registerTool("noargs", { description: "Takes nothing." }, async () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));
  s.registerTool("boom", { description: "Always throws.", inputSchema: {} }, async () => {
    throw new Error("kaboom");
  });
  s.registerTool(
    "shapes",
    {
      description: "Many schema shapes.",
      inputSchema: {
        mode: z.enum(["a", "b"]),
        tags: z.array(z.string()).default([]),
        nested: z.object({ x: z.boolean(), y: z.string().optional() }).optional(),
        level: z.number().default(3),
        either: z.union([z.string(), z.number()]).optional(),
      },
    },
    async (args) => ({
      content: [{ type: "text" as const, text: JSON.stringify(args) }],
    }),
  );
  s.registerTool("failing", { description: "Reports its own failure." }, async () => ({
    content: [{ type: "text" as const, text: "refused" }],
    isError: true,
  }));
}

describe("StdioMcpServer initialize", () => {
  it("answers initialize like the SDK server: version, capabilities, server info, instructions", async () => {
    const { sdk, own } = await onBoth(fixtureTools, (w) => handshake(w));
    assert.deepEqual(own, sdk);
  });

  it("negotiates the protocol version like the SDK server, for every version and an unknown one", async () => {
    for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "1999-01-01"]) {
      const { sdk, own } = await onBoth(fixtureTools, (w) => handshake(w, version));
      assert.deepEqual(own, sdk, version);
    }
  });

  it("answers ping with an empty result, and an unknown method with -32601", async () => {
    const { sdk, own } = await onBoth(fixtureTools, async (w) => {
      await handshake(w);
      return [await ask(w, "ping", undefined, 7), await ask(w, "nope/nothing", undefined, 8)];
    });
    assert.deepEqual(own, sdk);
    assert.deepEqual(own[0], { jsonrpc: "2.0", id: 7, result: {} });
  });

  it("serves a real SDK client end to end", async () => {
    const server = new StdioMcpServer(INFO, { instructions: INSTRUCTIONS });
    fixtureTools(server as unknown as Registrar);
    const toServer = new PassThrough();
    const toClient = new PassThrough();
    const done = server.connect(toServer, toClient);
    const buffer = new ReadBuffer();
    const transport: Transport = {
      onmessage: undefined,
      async start() {
        toClient.on("data", (chunk: Buffer) => {
          buffer.append(chunk);
          for (let m = buffer.readMessage(); m; m = buffer.readMessage()) this.onmessage?.(m);
        });
      },
      async send(message: JSONRPCMessage, _options?: TransportSendOptions) {
        toServer.write(serializeMessage(message));
      },
      async close() {
        toServer.end();
      },
    };
    const client = new Client({ name: "real", version: "1" });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
      "boom",
      "echo",
      "failing",
      "noargs",
      "shapes",
    ]);
    const r = await client.callTool({ name: "echo", arguments: { text: "ab", times: 2 } });
    assert.deepEqual(r.content, [{ type: "text", text: "abab" }]);
    await client.close();
    await done;
  });
});

describe("StdioMcpServer tools", () => {
  it("lists tools with the same names, titles, descriptions, JSON Schemas and annotations", async () => {
    const { sdk, own } = await onBoth(fixtureTools, async (w) => {
      await handshake(w);
      return ask(w, "tools/list", {}, 2);
    });
    assert.deepEqual(own, sdk);
  });

  it("calls a tool with the same result", async () => {
    const calls: [string, Msg][] = [
      ["echo", { text: "hi", times: 3 }],
      ["noargs", {}],
      ["shapes", { mode: "b", nested: { x: true } }],
      ["failing", {}],
    ];
    for (const [name, args] of calls) {
      const { sdk, own } = await onBoth(fixtureTools, async (w) => {
        await handshake(w);
        return ask(w, "tools/call", { name, arguments: args }, 3);
      });
      assert.deepEqual(own, sdk, name);
    }
  });

  it("reports a throwing handler as a tool error with the same text", async () => {
    const { sdk, own } = await onBoth(fixtureTools, async (w) => {
      await handshake(w);
      return ask(w, "tools/call", { name: "boom", arguments: {} }, 4);
    });
    assert.deepEqual(own, sdk);
    assert.match(JSON.stringify(own), /kaboom/);
  });

  it("refuses an unknown tool and bad arguments the way the SDK does", async () => {
    const bad: [string, unknown][] = [
      ["missing", {}],
      ["echo", {}],
      ["echo", { text: 5 }],
      ["echo", { text: "x", times: 99 }],
      ["shapes", { mode: "c" }],
      ["echo", undefined],
    ];
    for (const [name, args] of bad) {
      const { sdk, own } = await onBoth(fixtureTools, async (w) => {
        await handshake(w);
        return ask(
          w,
          "tools/call",
          { name, ...(args === undefined ? {} : { arguments: args }) },
          5,
        );
      });
      assert.deepEqual(own, sdk, `${name} ${JSON.stringify(args)}`);
    }
  });

  it("answers requests that overlap, each with its own id", async () => {
    const own = await ownWire(fixtureTools);
    try {
      await handshake(own);
      for (let id = 10; id < 15; id++) {
        own.send({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "echo", arguments: { text: `m${id}` } },
        });
      }
      const seen = new Set<unknown>();
      for (let i = 0; i < 5; i++) seen.add((await own.next()).id);
      assert.deepEqual([...seen].sort(), [10, 11, 12, 13, 14]);
    } finally {
      await own.close();
    }
  });
});

describe("StdioMcpServer framing", () => {
  it("ignores a line that is not JSON-RPC, as the SDK does, and keeps serving", async () => {
    // InMemoryTransport carries objects, not text, so the SDK side of this has no wire to compare.
    // The SDK's stdio transport reports such a line to onerror and sends no reply.
    const server = new StdioMcpServer(INFO, {});
    fixtureTools(server as unknown as Registrar);
    const input = new PassThrough();
    const output = new PassThrough();
    const done = server.connect(input, output);
    const got: string[] = [];
    output.on("data", (c: Buffer) => got.push(c.toString()));
    input.write("not json\n");
    input.write('{"hello":"world"}\n');
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" })}\n`);
    input.end();
    await done;
    assert.equal(got.join(""), `${JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} })}\n`);
  });

  it("splits input on newlines, also when a message arrives in pieces", async () => {
    const server = new StdioMcpServer(INFO, {});
    fixtureTools(server as unknown as Registrar);
    const input = new PassThrough();
    const output = new PassThrough();
    const done = server.connect(input, output);
    const got: string[] = [];
    output.on("data", (c: Buffer) => got.push(c.toString()));
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    input.write(line.slice(0, 10));
    input.write(`${line.slice(10)}\r\n`);
    input.end();
    await done;
    assert.equal(got.join(""), `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  });

  it("refuses an output schema, which no kit tool uses", () => {
    const server = new StdioMcpServer(INFO, {});
    assert.throws(
      () =>
        (server as unknown as Registrar).registerTool(
          "x",
          { outputSchema: { n: z.number() } },
          async () => ({ content: [] }),
        ),
      /outputSchema/,
    );
  });
});

describe("StdioMcpServer in its own process", () => {
  it("serves the SDK's stdio client over real standard input and output, and exits when input ends", async () => {
    const module = new URL("./mcp-stdio.js", import.meta.url).href;
    const code = `
      import { StdioMcpServer } from ${JSON.stringify(module)};
      const s = new StdioMcpServer({ name: "kit", version: "0.1.0" }, { instructions: "hi" });
      s.registerTool("hello", { description: "Say hello." }, async () => ({ content: [{ type: "text", text: "hello" }] }));
      await s.connect(process.stdin, process.stdout);
    `;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--input-type=module", "-e", code],
    });
    const client = new Client({ name: "real", version: "1" });
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, "kit");
    assert.equal(client.getInstructions(), "hi");
    const r = await client.callTool({ name: "hello", arguments: {} });
    assert.deepEqual(r.content, [{ type: "text", text: "hello" }]);
    await client.close(); // closes the child's stdin; the child must end by itself
  });
});
