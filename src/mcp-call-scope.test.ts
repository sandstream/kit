/**
 * A vendor-CLI pin refusal inside the long-running MCP server is that tool call's error: it does
 * not set the server's `process.exitCode`, and it does not leak into later or concurrent calls.
 * On the CLI (no call scope) the same refusal still makes the process exit non-zero.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioMcpServer } from "./mcp-stdio.js";
import { execPinned } from "./vendor-cli-pin.js";
import { pinOne } from "./commands/tools-pin.js";
import { makeFixture, opStub, POSIX_ONLY, type Fixture } from "./vendor-cli-pin.test-support.js";

describe("MCP server: a pin refusal is the tool call's error", { skip: POSIX_ONLY }, () => {
  let f: Fixture;
  let client: Client;
  let restore: () => void;

  beforeEach(async () => {
    f = makeFixture();
    process.env.PATH = f.bin;
    assert.equal((await pinOne("op", false, f.deps, f.io)).result, "pinned");
    f.writeOp(f.bin, opStub("2.30.0", "tampered"));
    f.clearLog();
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    restore = () => (process.stderr.write = write);

    const server = new StdioMcpServer({ name: "t", version: "0" });
    // Like the secret backends: the refusal is swallowed into an ordinary-looking answer.
    server.registerTool("read", { description: "op read" }, async () => {
      const v = await execPinned("op", ["read", "op://x/y/z"], { cwd: f.proj }).catch(() => null);
      return { content: [{ type: "text", text: v ? "found" : "not found" }] };
    });
    server.registerTool("ping2", { description: "harmless" }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "c", version: "0" }, { capabilities: {} });
    await server.connect(st);
    await client.connect(ct);
  });

  afterEach(async () => {
    await client.close();
    restore();
    f.done();
  });

  const texts = (r: Awaited<ReturnType<Client["callTool"]>>) =>
    (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");

  it("surfaces on that call, never on the server's exit code or on later calls", async () => {
    process.exitCode = undefined;
    const refused = await client.callTool({ name: "read", arguments: {} });
    assert.equal(refused.isError, true);
    assert.match(texts(refused), /kit refused to run op: its SHA-256 differs from the pin/);
    assert.equal(f.logged(), "", "the tampered op never ran");
    assert.equal(process.exitCode, undefined, "the server's exit code is untouched");

    const later = await client.callTool({ name: "ping2", arguments: {} });
    assert.notEqual(later.isError, true);
    assert.equal(texts(later), "pong");

    // Not suppressed by the once-per-process stderr announcement: every refused call says so.
    const again = await client.callTool({ name: "read", arguments: {} });
    assert.equal(again.isError, true);
    assert.match(texts(again), /kit refused to run op/);
    assert.equal(process.exitCode, undefined);

    process.exitCode = 0;
    assert.equal((await pinOne("op", true, f.deps, f.io)).result, "accepted");
    const accepted = await client.callTool({ name: "read", arguments: {} });
    assert.notEqual(accepted.isError, true);
    assert.match(f.logged(), /^read op:\/\/x\/y\/z$/m);
  });

  it("the CLI keeps its non-zero exit: the same refusal outside the server sets exitCode", async () => {
    process.exitCode = undefined;
    await execPinned("op", ["read", "op://x/y/z"], { cwd: f.proj }).catch(() => null);
    assert.equal(process.exitCode, 1);
    assert.equal(f.logged(), "");
  });
});
