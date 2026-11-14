import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * `kit mcp --read-only` is what `kit mcp web` hands to the ChatGPT tunnel. It printed the usage
 * text instead of starting the stdio server, because `--read-only` was read as a sub-command
 * (kit-research t3-connect-device-approval-vs-kit). This starts the built CLI the way an MCP
 * client does.
 */
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");

describe("kit mcp --read-only", () => {
  it("starts the stdio server and refuses kit_run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-mcp-ro-"));
    const marker = join(dir, "written");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp", "--read-only"],
      cwd: dir,
      env: { ...process.env, NO_COLOR: "1", KIT_READ_ONLY: "" } as Record<string, string>,
      stderr: "ignore",
    });
    const client = new Client({ name: "read-only-probe", version: "0" });
    try {
      writeFileSync(join(dir, ".env.local"), "DEMO=1\n");
      await client.connect(transport);
      const run = await client.callTool({
        name: "kit_run",
        arguments: { command: `node -e "require('fs').writeFileSync('written','x')"`, cwd: dir },
      });
      assert.equal(run.isError, true);
      const text = (run.content as { text: string }[])[0].text;
      assert.match(text, /read-only mode active/);
      assert.equal(existsSync(marker), false, "the command must not have run");
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
