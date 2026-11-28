/**
 * A Model Context Protocol server for stdio, with no dependency beyond `zod`.
 *
 * kit speaks one transport (JSON-RPC 2.0 over stdio, one JSON message per line) and serves tools
 * only. The MCP SDK ships a complete HTTP and OAuth stack for the transports kit does not use, and
 * that stack is most of the packages kit installs. This file is the part of the SDK kit uses:
 * `initialize` with version negotiation, `ping`, `tools/list` and `tools/call`.
 *
 * It copies the SDK's observable behaviour, and `mcp-stdio.test.ts` holds it to that by driving the
 * SDK server and this one with the same messages. Where it differs, the test names the difference.
 *
 * Not supported, on purpose: resources, prompts, sampling, tasks, an output schema, progress and
 * cancellation. No kit tool uses them. A client that asks for them gets `-32601`.
 *
 * Standard input and output carry protocol messages only. Nothing here writes anything else there.
 */
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { runInCallScope } from "./utils/call-scope.js";

/** Newest first. Same list as the SDK at the version kit pins. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

/** The SDK's default ceiling for one unfinished line. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: string; [key: string]: unknown }[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * A message channel. The shape is the SDK's `Transport`, so a test can serve this server over the
 * SDK's in-memory pair. Methods (not function properties) so that the SDK's own types fit.
 */
export interface McpTransport {
  onmessage?(message: never): void;
  onclose?(): void;
  start(): Promise<void>;
  send(message: never): Promise<void>;
  close(): Promise<void>;
}

/** What a handler is given besides its arguments. */
export interface ToolExtra {
  signal: AbortSignal;
}

type ToolHandler = (...args: never[]) => ToolResult | Promise<ToolResult>;

/** A handler's type follows the tool's input schema: arguments as parsed, or none without one. */
type HandlerFor<S extends z.ZodRawShape | undefined> = S extends z.ZodRawShape
  ? (args: z.output<z.ZodObject<S>>, extra: ToolExtra) => ToolResult | Promise<ToolResult>
  : (extra: ToolExtra) => ToolResult | Promise<ToolResult>;

interface Tool {
  config: ToolConfig;
  schema: z.ZodObject | undefined;
  handler: ToolHandler;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The text the SDK gives for a failed parse: each issue, with its path, one per line. */
function issueText(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.message} at ${i.path.join(".")}` : i.message))
    .join("\n");
}

/** What the SDK's McpError says: the code in front of the text. A handler's own error has no prefix. */
const protocolText = (code: number, text: string): string => `MCP error ${code}: ${text}`;

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export class StdioMcpServer {
  private readonly tools = new Map<string, Tool>();

  constructor(
    private readonly info: { name: string; version: string },
    private readonly options: { instructions?: string } = {},
  ) {}

  registerTool<S extends z.ZodRawShape | undefined = undefined>(
    name: string,
    config: Omit<ToolConfig, "inputSchema"> & { inputSchema?: S },
    handler: HandlerFor<S>,
  ): void {
    if ("outputSchema" in config) {
      throw new Error(`Tool ${name}: outputSchema is not supported by this server`);
    }
    if (this.tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    const schema = config.inputSchema ? z.object(config.inputSchema) : undefined;
    this.tools.set(name, { config, schema, handler: handler as ToolHandler });
  }

  /** Resolves when the transport the server is connected to has closed and every answer is sent. */
  closed: Promise<void> = Promise.resolve();
  private transport: McpTransport | undefined;

  /**
   * Start serving on a transport. Requests run at the same time, as in the SDK, and each answer
   * carries its own id. Resolves when the transport has started.
   */
  async connect(transport: McpTransport): Promise<void> {
    const pending = new Set<Promise<void>>();
    let done: () => void = () => undefined;
    this.closed = new Promise((resolve) => (done = resolve));
    this.transport = transport;
    (transport as { onmessage?: (m: unknown) => void }).onmessage = (message) => {
      const job = this.handleMessage(message, (reply) => transport.send(reply as never)).finally(
        () => pending.delete(job),
      );
      pending.add(job);
    };
    transport.onclose = () => void Promise.all(pending).then(done);
    await transport.start();
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }

  private async handleMessage(
    message: unknown,
    send: (reply: object) => Promise<void>,
  ): Promise<void> {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return; // a response to nothing we asked, or not JSON-RPC
    }
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") return; // a notification: no reply
    try {
      const result = await this.handleRequest(message.method, message.params);
      await send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const known = error instanceof RpcError;
      await send({
        jsonrpc: "2.0",
        id,
        error: {
          code: known ? error.code : INTERNAL_ERROR,
          message: error instanceof Error ? error.message : "Internal error",
        },
      }).catch(() => undefined); // the client went away: nobody is left to tell
    }
  }

  private async handleRequest(method: string, params: unknown): Promise<object> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: [...this.tools].map(([name, tool]) => this.describe(name, tool)) };
      case "tools/call":
        return this.callTool(params);
      default:
        throw new RpcError(METHOD_NOT_FOUND, "Method not found");
    }
  }

  private initialize(params: unknown): object {
    if (!isRecord(params) || typeof params.protocolVersion !== "string") {
      throw new RpcError(INVALID_PARAMS, "initialize needs a protocolVersion");
    }
    const asked = params.protocolVersion;
    return {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
        ? asked
        : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: this.tools.size > 0 ? { tools: { listChanged: true } } : {},
      serverInfo: this.info,
      ...(this.options.instructions && { instructions: this.options.instructions }),
    };
  }

  private describe(name: string, tool: Tool): object {
    const { title, description, annotations, _meta } = tool.config;
    return {
      name,
      title,
      description,
      inputSchema: tool.schema
        ? z.toJSONSchema(tool.schema, { target: "draft-7", io: "input" })
        : { type: "object", properties: {} },
      annotations,
      // The SDK states this on every tool. Clients on protocol 2025-11-25 read it.
      execution: { taskSupport: "forbidden" },
      _meta,
    };
  }

  private async callTool(params: unknown): Promise<ToolResult> {
    if (!isRecord(params) || typeof params.name !== "string") {
      throw new RpcError(INVALID_PARAMS, "tools/call needs a tool name");
    }
    const { name } = params;
    const tool = this.tools.get(name);
    // Like the SDK, a failure the model can act on is a tool result with isError, not a protocol error.
    if (!tool) return toolError(protocolText(INVALID_PARAMS, `Tool ${name} not found`));
    // Each call is its own scope: a failure that would set the CLI's exit code (a vendor-CLI pin
    // refusal) becomes this call's error instead, and never the server process's exit code.
    const { value, failures } = await runInCallScope(() => this.dispatch(tool, name, params));
    if (failures.length === 0) return value;
    return {
      ...value,
      content: [...value.content, ...failures.map((text) => ({ type: "text", text }))],
      isError: true,
    };
  }

  private async dispatch(
    tool: Tool,
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      const extra = { signal: new AbortController().signal };
      if (!tool.schema) return await (tool.handler as (e: typeof extra) => ToolResult)(extra);
      const parsed = await tool.schema.safeParseAsync(params.arguments ?? {});
      if (!parsed.success) {
        return toolError(
          protocolText(
            INVALID_PARAMS,
            `Input validation error: Invalid arguments for tool ${name}: ${issueText(parsed.error)}`,
          ),
        );
      }
      return await (tool.handler as (a: unknown, e: typeof extra) => ToolResult)(
        parsed.data,
        extra,
      );
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }
}

/** One JSON message per line on a pair of streams: what an agent's stdio client speaks. */
export function stdioTransport(input: Readable, output: Writable): McpTransport {
  const transport: McpTransport & { onmessage?(message: object): void } = {
    async start() {
      output.on("error", () => undefined); // the client went away: nobody is left to tell
      let buffer = Buffer.alloc(0);
      input.on("data", (chunk: Buffer) => {
        if (buffer.length + chunk.length > MAX_BUFFER_BYTES) {
          buffer = Buffer.alloc(0); // a message this large is refused, as the SDK does
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        for (let at = buffer.indexOf(10); at !== -1; at = buffer.indexOf(10)) {
          const line = buffer.toString("utf8", 0, at).replace(/\r$/, "");
          buffer = buffer.subarray(at + 1);
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            continue; // not JSON: the SDK reports it to onerror and sends no reply
          }
          (transport.onmessage as ((m: unknown) => void) | undefined)?.(message);
        }
      });
      const finish = (): void => transport.onclose?.();
      input.once("end", finish);
      input.once("close", finish);
    },
    async send(message) {
      output.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      input.pause();
    },
  };
  return transport;
}

/** Serve on standard input and output until input ends and the last answer is written. */
export async function serveStdio(
  server: StdioMcpServer,
  input: Readable,
  output: Writable,
): Promise<void> {
  await server.connect(stdioTransport(input, output));
  await server.closed;
}
