import { PassThrough } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { StdioMcpServer } from "./mcp-stdio.js";

/** Drive the SDK server and kit's own stdio server with the same JSON-RPC messages. */

export type Registrar = Pick<McpServer, "registerTool">;
export type Msg = Record<string, unknown>;

export const INFO = { name: "kit", version: "0.1.0" };
export const INSTRUCTIONS = "Use kit for checks.";

/** One end of a JSON-RPC conversation, the same for both servers. */
export interface Wire {
  send(message: Msg): void;
  next(): Promise<Msg>;
  close(): Promise<void>;
}

function queue(): { push(m: Msg): void; next(): Promise<Msg> } {
  const items: Msg[] = [];
  const waiting: ((m: Msg) => void)[] = [];
  return {
    push(m) {
      const w = waiting.shift();
      if (w) w(m);
      else items.push(m);
    },
    next() {
      const m = items.shift();
      return m ? Promise.resolve(m) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}

/** A conversation with a ready-made SDK server. */
export async function sdkWireFor(server: McpServer): Promise<Wire> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const q = queue();
  clientSide.onmessage = (m) => q.push(JSON.parse(JSON.stringify(m)) as Msg); // as the wire would carry it
  await clientSide.start();
  return {
    send: (m) => void clientSide.send(m as unknown as JSONRPCMessage),
    next: q.next,
    close: () => server.close(),
  };
}

export function sdkWire(register: (s: Registrar) => void): Promise<Wire> {
  const server = new McpServer(INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  register(server);
  return sdkWireFor(server);
}

export async function ownWireFor(server: StdioMcpServer): Promise<Wire> {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = server.connect(input, output);
  const q = queue();
  const buffer = new ReadBuffer();
  output.on("data", (chunk: Buffer) => {
    buffer.append(chunk);
    for (let m = buffer.readMessage(); m; m = buffer.readMessage()) q.push(m as unknown as Msg);
  });
  return {
    send: (m) => void input.write(`${JSON.stringify(m)}\n`),
    next: q.next,
    close: async () => {
      input.end();
      await done;
    },
  };
}

export function ownWire(register: (s: Registrar) => void): Promise<Wire> {
  const server = new StdioMcpServer(INFO, { instructions: INSTRUCTIONS });
  register(server as unknown as Registrar);
  return ownWireFor(server);
}

export async function ask(wire: Wire, method: string, params?: Msg, id = 1): Promise<Msg> {
  wire.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  return wire.next();
}

export async function handshake(wire: Wire, version = "2025-11-25"): Promise<Msg> {
  const init = await ask(wire, "initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  wire.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return init;
}

/** Run one conversation on both servers and return what each said. */
export async function onBoth<T>(
  register: (s: Registrar) => void,
  run: (wire: Wire) => Promise<T>,
): Promise<{ sdk: T; own: T }> {
  const out: Partial<{ sdk: T; own: T }> = {};
  for (const [name, make] of [
    ["sdk", sdkWire],
    ["own", ownWire],
  ] as const) {
    const wire = await make(register);
    try {
      out[name] = await run(wire);
    } finally {
      await wire.close();
    }
  }
  return out as { sdk: T; own: T };
}
