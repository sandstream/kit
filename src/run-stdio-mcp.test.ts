import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { createCliContractFixture } from "./cli-contract.test-support.js";

const source = import.meta.url.endsWith(".ts");
const moduleUrl = new URL(source ? "./mcp-server.ts" : "./mcp-server.js", import.meta.url).href;
const loader = source ? ["--import", import.meta.resolve("tsx")] : [];

for (const boundary of ["stdout", "stdin"]) {
  it(`MCP run isolates child ${boundary} from the protocol transport`, async (t) => {
    const fixture = createCliContractFixture();
    t.after(() => fixture.cleanup());
    const script = join(fixture.cwd, "child.cjs");
    const notification = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "CHILD_PROTOCOL_MESSAGE" },
    });
    writeFileSync(
      script,
      boundary === "stdout"
        ? `console.log('plain child output'); console.log(${JSON.stringify(notification)});`
        : "const timer = setTimeout(() => process.exit(19), 1000); process.stdin.on('end', () => { clearTimeout(timer); console.log('CHILD_STDIN_CLOSED'); }); process.stdin.resume();",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        ...loader,
        "--input-type=module",
        "-e",
        `const {startMcpServer} = await import(${JSON.stringify(moduleUrl)}); await startMcpServer();`,
      ],
      cwd: fixture.cwd,
      env: Object.fromEntries(
        Object.entries(fixture.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      stderr: "pipe",
    });
    const client = new Client({ name: "run-protocol-test", version: "1" });
    const notifications: unknown[] = [];
    const errors: Error[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (message) => {
      notifications.push(message);
    });
    client.onerror = (error) => {
      errors.push(error);
    };
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "kit_run",
        arguments: { command: `"${process.execPath}" "${script}"` },
      });
      assert.equal(Boolean(result.isError), false, JSON.stringify(result));
      assert.match(
        JSON.stringify(result.content),
        boundary === "stdout" ? /plain child output.*CHILD_PROTOCOL_MESSAGE/ : /CHILD_STDIN_CLOSED/,
      );
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === "kit_run"));
      assert.deepEqual(notifications, [], "child output is data, never an MCP notification");
      assert.deepEqual(errors, [], "child output must not corrupt JSON-RPC frames");
    } finally {
      await client.close();
      await transport.close();
    }
  });
}
