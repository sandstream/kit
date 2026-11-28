/**
 * kit-research `nvidia-auto-ontology-vs-kit`: Claude Desktop's `claude_desktop_config.json` declares MCP
 * servers that start with the person's credentials, and `kit agent-audit` did not read it. Paths
 * per OS from https://modelcontextprotocol.io/docs/develop/connect-local-servers: macOS
 * `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`, Linux `~/.config/Claude/`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeDesktopConfig, runClaudeDesktopAudit } from "./agent-audit-claude-desktop.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const KEY = ["sk", "ant", "api03", "x".repeat(93), "AA"].join("-");
const CONFIG = JSON.stringify({
  mcpServers: {
    db: { command: "npx", args: ["-y", "some-mcp-server"], env: { ANTHROPIC_API_KEY: KEY } },
    inline: { command: "node", args: ["-e", "require('child_process').exec('id')"] },
    pinned: { command: "npx", args: ["-y", "some-mcp-server@1.2.3"] },
  },
});

function home(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-claude-desktop-"));
  t.after(() => rmTemp(dir));
  return dir;
}

function plant(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

describe("claudeDesktopConfig", () => {
  it("resolves the documented path on each OS", () => {
    const h = join("h");
    const mac = claudeDesktopConfig(h, {}, "darwin");
    assert.equal(
      mac.path,
      join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
    const win = claudeDesktopConfig(h, { APPDATA: join("ad") }, "win32");
    assert.equal(win.path, join("ad", "Claude", "claude_desktop_config.json"));
    assert.equal(win.shown, "%APPDATA%\\Claude\\claude_desktop_config.json");
    const linux = claudeDesktopConfig(h, {}, "linux");
    assert.equal(linux.path, join(h, ".config", "Claude", "claude_desktop_config.json"));
    const xdg = resolve("xdg");
    const moved = claudeDesktopConfig(h, { XDG_CONFIG_HOME: xdg }, "linux");
    assert.equal(moved.path, join(xdg, "Claude", "claude_desktop_config.json"));
    assert.equal(claudeDesktopConfig(h, { XDG_CONFIG_HOME: "rel" }, "linux").path, linux.path);
  });
});

describe("runClaudeDesktopAudit", () => {
  it("runs the secret, inline-code and pin checks on each OS path", (t) => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const h = home(t);
      const env = { APPDATA: join(h, "AppData", "Roaming") };
      const { path, shown } = claudeDesktopConfig(h, env, platform);
      plant(path, CONFIG);
      const names = runClaudeDesktopAudit(h, env, platform).map((r) => r.name);
      assert.deepEqual(
        names.sort(),
        [
          `risky MCP server "inline" in Claude Desktop config ${shown}`,
          `secret in Claude Desktop config ${shown}`,
          `unpinned MCP runner "db" in ${shown}`,
        ],
        platform,
      );
    }
  });

  it("gives no row without the file", (t) => {
    assert.deepEqual(runClaudeDesktopAudit(home(t), {}, "linux"), []);
  });
});

describe("kit agent-audit", () => {
  it("reads Claude Desktop's config on this OS", (t) => {
    const h = home(t);
    const root = join(h, "proj");
    mkdirSync(root);
    const env = { APPDATA: join(h, "AppData", "Roaming") };
    const { path, shown } = claudeDesktopConfig(h, env, process.platform);
    plant(path, CONFIG);
    const cli = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const r = spawnSync(process.execPath, [cli, "agent-audit", "--json"], {
      cwd: root,
      encoding: "utf-8",
      env: {
        ...process.env,
        ...env,
        HOME: h,
        USERPROFILE: h,
        KIT_NO_UPDATE_CHECK: "1",
        KIT_AUDIT_ANCHOR: "0",
        CODEX_HOME: "",
        CLAUDE_CONFIG_DIR: "",
        XDG_CONFIG_HOME: "",
      },
      timeout: 60_000,
    });
    const names = (JSON.parse(r.stdout) as { results: { name: string }[] }).results.map(
      (x) => x.name,
    );
    assert.ok(names.includes(`secret in Claude Desktop config ${shown}`), names.join("\n"));
  });
});
