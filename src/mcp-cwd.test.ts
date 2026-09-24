import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cwd-test", version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: () => client.close() };
}

describe("MCP working-directory responses", () => {
  it("returns an absolute detail.path for a relative requested cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "kit-mcp-cwd-"));
    const savedCwd = process.cwd();
    let close: (() => Promise<void>) | undefined;
    try {
      const project = join(root, "relative-project");
      await mkdir(project);
      await writeFile(join(project, ".kit.toml"), "# empty kit config\n", "utf8");
      process.chdir(root);
      const connection = await connectedClient();
      close = connection.close;
      const result = await connection.client.callTool(
        { name: "kit_check", arguments: { cwd: "relative-project" } },
        undefined,
        { timeout: 150_000 },
      );
      const data = JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
        detail?: { path: string };
      };
      assert.ok(data.detail?.path);
      assert.equal(isAbsolute(data.detail.path), true);
      assert.equal(
        realpathSync(dirname(data.detail.path)),
        realpathSync(join(project, ".kit", "runs")),
      );
      assert.ok(readFileSync(data.detail.path, "utf8").includes('"ok"'));
    } finally {
      if (close) await close();
      process.chdir(savedCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("identifies a missing requested cwd before spawning kit_run", async () => {
    const root = await mkdtemp(join(tmpdir(), "kit-mcp-cwd-"));
    const { client, close } = await connectedClient();
    try {
      const result = await client.callTool({
        name: "kit_run",
        arguments: { command: "echo hello", cwd: join(root, "missing-project") },
      });
      assert.equal(result.isError, true);
      const message = (result.content as Array<{ text: string }>)[0].text;
      assert.match(message, /working directory .*does not exist/i);
      assert.match(message, /missing-project/);
      assert.doesNotMatch(message, /ENOENT/);
    } finally {
      await close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
