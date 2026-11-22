/**
 * kit-research fast-anything-vs-kit: a Claude Code plugin can register an MCP server (`.mcp.json`
 * at its root, or `mcpServers` in plugin.json). The server's command starts with every session,
 * like a hook, and plugin triage did not report it at all: the plugin read "0 hook command(s)".
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { warmPython } from "./python-warmup.test-support.js";

// The first python3 start of a cold Windows job can outlast the 30 s per-run limit.
before(() => warmPython());

const exec = promisify(execFile);
const TRIAGE_PY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "triage",
  "scripts",
  "triage.py",
);
const MANIFEST = JSON.stringify({ name: "probe", version: "0.1.0" });

async function triagePlugin(
  t: { after(fn: () => void): void; skip(m: string): void },
  files: Record<string, string>,
): Promise<string | null> {
  const root = mkdtempSync(join(tmpdir(), "kit-triage-plugin-mcp-"));
  t.after(() => rmTemp(root));
  const dir = join(root, "plugin");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  try {
    return (await exec("python3", ["-I", TRIAGE_PY, "skill", dir], { timeout: 30_000 })).stdout;
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string };
    if (e.code === "ENOENT") {
      t.skip(
        "python3 not installed — plugin_scan.py's MCP server report is NOT verified in this run",
      );
      return null;
    }
    return e.stdout ?? "";
  }
}

const mcp = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers });

describe("triage skill <plugin>: the MCP servers a plugin registers", () => {
  it("warns on a server that runs a program from PATH the plugin does not ship", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": MANIFEST,
      ".mcp.json": mcp({ fast: { command: "fast-anything", args: ["mcp"] } }),
    });
    if (out === null) return;
    assert.match(out, /plugin registers 1 MCP server\(s\)/, out);
    assert.match(out, /MCP server 'fast' runs `fast-anything` from PATH on every session/);
  });

  it("warns on an unpinned runner and on a remote server, from plugin.json too", async (t) => {
    const manifest = JSON.stringify({
      name: "probe",
      version: "0.1.0",
      mcpServers: {
        runner: { command: "npx", args: ["-y", "@acme/server"] },
        remote: { type: "http", url: "https://mcp.acme.example/v1" },
      },
    });
    const out = await triagePlugin(t, { ".claude-plugin/plugin.json": manifest });
    if (out === null) return;
    assert.match(out, /plugin registers 2 MCP server\(s\)/, out);
    assert.match(out, /`npx @acme\/server` runs the newest published version/);
    assert.match(out, /MCP server 'remote' is remote \(mcp\.acme\.example\)/);
  });

  it("reports a server the plugin ships itself as a fact, not a warning", async (t) => {
    const out = await triagePlugin(t, {
      ".claude-plugin/plugin.json": MANIFEST,
      ".mcp.json": mcp({ own: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.js"] } }),
      "server.js": "console.log(1)\n",
    });
    if (out === null) return;
    assert.match(out, /MCP server 'own' runs `node \$\{CLAUDE_PLUGIN_ROOT\}\/server\.js`/, out);
    assert.doesNotMatch(out, /from PATH on every session/);
  });

  it("says 0 for a plugin without one", async (t) => {
    const out = await triagePlugin(t, { ".claude-plugin/plugin.json": MANIFEST });
    if (out === null) return;
    assert.match(out, /plugin registers 0 MCP server\(s\)/, out);
  });
});
