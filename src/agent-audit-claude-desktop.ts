/**
 * Claude Desktop's MCP servers. `claude_desktop_config.json` declares stdio servers under
 * `mcpServers`, each started with the person's credentials when the app opens, and often carries
 * API keys in their `env`. `kit agent-audit` read Claude Code, Codex, Cursor and the editors, not
 * this file (kit-research `nvidia-auto-ontology-vs-kit`).
 *
 * Paths, from https://modelcontextprotocol.io/docs/develop/connect-local-servers (read 2026-11-28):
 *   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
 *   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
 *   - Linux: `~/.config/Claude/claude_desktop_config.json`; Electron puts it under
 *     `$XDG_CONFIG_HOME` when that is set to an absolute path, so kit follows it there.
 *
 * The checks are the ones every other MCP config gets: plaintext secrets, malware-shaped and
 * inline-code stdio servers (`surfaceRows`), and unpinned `npx`/`uvx` runners (`mcpLaunchRows`).
 * The "runs repository code" row is left out: Desktop starts servers from no checkout. Desktop
 * extensions (`.mcpb`) keep their own settings and are not read. Read-only; fail-open.
 */
import { dirname, isAbsolute, join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { surfaceRows } from "./agent-audit-user.js";
import { mcpLaunchRows } from "./agent-audit-mcp-launch.js";
import { readInstructionFile } from "./instruction-scan.js";

const FILE = "claude_desktop_config.json";

/** Where Claude Desktop keeps its config on `platform`, and how kit shows it. Pure. */
export function claudeDesktopConfig(
  home: string,
  env: Record<string, unknown>,
  platform: NodeJS.Platform,
): { path: string; shown: string } {
  if (platform === "darwin") {
    return {
      path: join(home, "Library", "Application Support", "Claude", FILE),
      shown: `~/Library/Application Support/Claude/${FILE}`,
    };
  }
  if (platform === "win32") {
    const appData =
      typeof env.APPDATA === "string" && env.APPDATA
        ? env.APPDATA
        : join(home, "AppData", "Roaming");
    return { path: join(appData, "Claude", FILE), shown: `%APPDATA%\\Claude\\${FILE}` };
  }
  const xdg = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  if (xdg && isAbsolute(xdg)) {
    return { path: join(xdg, "Claude", FILE), shown: `$XDG_CONFIG_HOME/Claude/${FILE}` };
  }
  return { path: join(home, ".config", "Claude", FILE), shown: `~/.config/Claude/${FILE}` };
}

/** Secret, launch and pin rows for Claude Desktop's MCP servers on this machine. */
export function runClaudeDesktopAudit(
  home: string,
  env: Record<string, unknown> = {},
  platform: NodeJS.Platform = process.platform,
): SecurityCheckResult[] {
  const { path, shown } = claudeDesktopConfig(home, env, platform);
  const body = readInstructionFile(path);
  if (body === null) return [];
  const unpinned = mcpLaunchRows(body, dirname(path), shown).filter((r) =>
    r.name.startsWith("unpinned MCP runner"),
  );
  return [...surfaceRows(shown, "Claude Desktop config", body), ...unpinned];
}
