import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";

it("kit_init does not follow a dangling config symlink", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kit-mcp-init-exclusive-"));
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "init-exclusive-test", version: "1.0.0" },
    { capabilities: {} },
  );
  try {
    await writeFile(join(dir, "package.json"), "{}", "utf-8");
    await symlink("missing-config", join(dir, ".kit.toml"));
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "kit_init",
      arguments: { cwd: dir, dry_run: false },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as { written: boolean; alreadyExists: boolean };
    assert.equal(data.written, false);
    assert.equal(data.alreadyExists, true);
    assert.equal((await lstat(join(dir, ".kit.toml"))).isSymbolicLink(), true);
    await assert.rejects(readFile(join(dir, "missing-config"), "utf-8"), { code: "ENOENT" });
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
