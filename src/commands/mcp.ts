// `kit mcp` command (MCP orchestrator + stdio server) — extracted from cli.ts (split step 5).
import { startMcpServer } from "../mcp-server.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";

export async function cmdMcp(): Promise<boolean> {
  const sub = process.argv[3];

  // An MCP client launches `kit mcp` and speaks the stdio transport — no
  // sub-command and a non-TTY stdin. Start the server in that case. Interactive
  // use (TTY) or any explicit sub falls through to the orchestrator below.
  if (!sub && !process.stdin.isTTY) {
    await startMcpServer();
    return true;
  }

  const config = await loadConfig(resolveConfigPath()).catch(() => null);
  const mcpConfig = config?.mcp;
  const { statusAll, statusForMcp, clearMcpToken, storeStaticToken } =
    await import("../mcp-orchestrator.js");

  if (!sub || sub === "list" || sub === "status") {
    console.log(`${c.bold}${c.cyan}kit mcp${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
    const entries = await statusAll(mcpConfig);
    if (entries.length === 0) {
      console.log(`${c.dim}No [mcp.*] blocks declared in .kit.toml${c.reset}`);
      console.log(`${c.dim}Add e.g. [mcp.sentry] scopes = ["org:read", "project:write"]${c.reset}`);
      return true;
    }
    for (const e of entries) {
      const color =
        e.status === "ok"
          ? c.green
          : e.status === "missing" || e.status === "expired"
            ? c.yellow
            : c.red;
      const marker = e.status === "ok" ? "✓" : e.status === "missing" ? "?" : "✗";
      const scopeStr = e.declared?.scopes
        ? ` ${c.dim}[${e.declared.scopes.join(", ")}]${c.reset}`
        : "";
      console.log(
        `  ${color}${marker}${c.reset} ${e.name.padEnd(14)} ${color}${e.status}${c.reset}${scopeStr}`,
      );
      if (e.detail) console.log(`     ${c.dim}${e.detail}${c.reset}`);
    }
    console.log();
    return entries.every((e) => e.status === "ok" || e.status === "missing");
  }

  if (sub === "auth") {
    const name = process.argv[4];
    if (!name) {
      console.error(`${c.red}Usage: kit mcp auth <name>${c.reset}`);
      return false;
    }
    const declared = mcpConfig?.[name];
    if (!declared) {
      console.error(`${c.red}No [mcp.${name}] block in .kit.toml${c.reset}`);
      return false;
    }
    // For now we surface vendor-specific guidance; full OAuth flow is
    // delegated to the operator (paste callback URL). When the vendor's
    // MCP server publishes a stable /authorize endpoint we can fully
    // automate.
    const authUrl = declared.url ?? `https://mcp.${name}.dev`;
    console.log(`${c.bold}Authorize kit for MCP server "${name}"${c.reset}`);
    console.log(`${c.dim}Vendor URL: ${authUrl}${c.reset}`);
    console.log(
      `${c.dim}Required scopes: ${(declared.scopes ?? ["(none declared)"]).join(", ")}${c.reset}\n`,
    );
    console.log(`${c.yellow}OAuth-flow not yet automated for "${name}". Two options:${c.reset}`);
    console.log(`  1. Set env var: ${c.bold}kit mcp set-token ${name} --from-env <VAR>${c.reset}`);
    console.log(`  2. Paste token: ${c.bold}kit mcp set-token ${name} --paste${c.reset}`);
    return true;
  }

  if (sub === "set-token") {
    const name = process.argv[4];
    if (!name) {
      console.error(`${c.red}Usage: kit mcp set-token <name> [--from-env VAR | --paste]${c.reset}`);
      return false;
    }
    const args = process.argv.slice(5);
    const fromEnvIdx = args.indexOf("--from-env");
    let accessToken: string | undefined;
    if (fromEnvIdx >= 0 && args[fromEnvIdx + 1]) {
      const envVar = args[fromEnvIdx + 1];
      accessToken = process.env[envVar];
      if (!accessToken) {
        console.error(`${c.red}Env var ${envVar} is empty${c.reset}`);
        return false;
      }
    } else if (hasFlag(args, "--paste")) {
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        accessToken = (await rl.question(`Paste access token for "${name}": `)).trim();
      } finally {
        rl.close();
      }
    } else {
      console.error(`${c.red}Missing --from-env <VAR> or --paste${c.reset}`);
      return false;
    }
    const declared = mcpConfig?.[name];
    await storeStaticToken(name, accessToken, {
      scopes: declared?.scopes,
    });
    console.log(
      `${c.green}✓${c.reset} Token stored for ${name} in ~/.kit/mcp-tokens.json (chmod 0o600)`,
    );
    const status = await statusForMcp(name, declared ?? null);
    console.log(`${c.dim}Status: ${status.status}${c.reset}`);
    return true;
  }

  if (sub === "clear") {
    const name = process.argv[4];
    if (!name) {
      console.error(`${c.red}Usage: kit mcp clear <name>${c.reset}`);
      return false;
    }
    await clearMcpToken(name);
    console.log(`${c.green}✓${c.reset} Cleared token for ${name}`);
    return true;
  }

  console.error(
    `${c.red}Usage: kit mcp [list | status | auth <name> | set-token <name> | clear <name>]${c.reset}`,
  );
  return false;
}
