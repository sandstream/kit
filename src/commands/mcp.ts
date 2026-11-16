// `kit mcp` command (MCP orchestrator + stdio server) — extracted from cli.ts (split step 5).
import { startMcpServer } from "../mcp-server.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function runWebWizard(): boolean {
  const wizard = fileURLToPath(new URL("../../scripts/chatgpt-web-wizard.sh", import.meta.url));
  const result = spawnSync("bash", [wizard], { stdio: "inherit" });
  if (!result.error) return result.status === 0;
  console.error(`${c.red}Could not start ChatGPT web setup: ${result.error.message}${c.reset}`);
  return false;
}

type McpConfigMap = NonNullable<Awaited<ReturnType<typeof loadConfig>>["mcp"]>;
type Orchestrator = typeof import("../mcp-orchestrator.js");

const usage = (text: string): boolean => {
  console.error(`${c.red}${text}${c.reset}`);
  return false;
};

async function listMcp(
  statusAll: Orchestrator["statusAll"],
  mcpConfig: McpConfigMap | undefined,
): Promise<boolean> {
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

function authMcp(name: string | undefined, mcpConfig: McpConfigMap | undefined): boolean {
  if (!name) return usage("Usage: kit mcp auth <name>");
  const declared = mcpConfig?.[name];
  if (!declared) return usage(`No [mcp.${name}] block in .kit.toml`);
  // Vendor guidance only: the OAuth flow is the operator's (paste the callback URL) until a vendor
  // publishes a stable /authorize endpoint that kit can automate.
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

/** The token for `set-token`: from an environment variable or pasted. Undefined means it printed why not. */
async function readToken(name: string, args: string[]): Promise<string | undefined> {
  const fromEnv = flagValue(args, "--from-env");
  if (fromEnv) {
    const token = process.env[fromEnv];
    if (!token) console.error(`${c.red}Env var ${fromEnv} is empty${c.reset}`);
    return token || undefined;
  }
  if (hasFlag(args, "--paste")) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(`Paste access token for "${name}": `)).trim();
    } finally {
      rl.close();
    }
  }
  console.error(`${c.red}Missing --from-env <VAR> or --paste${c.reset}`);
  return undefined;
}

async function setTokenMcp(
  name: string | undefined,
  mcpConfig: McpConfigMap | undefined,
  orchestrator: Orchestrator,
): Promise<boolean> {
  if (!name) return usage("Usage: kit mcp set-token <name> [--from-env VAR | --paste]");
  const accessToken = await readToken(name, process.argv.slice(5));
  if (accessToken === undefined) return false;
  const declared = mcpConfig?.[name];
  await orchestrator.storeStaticToken(name, accessToken, { scopes: declared?.scopes });
  console.log(
    `${c.green}✓${c.reset} Token stored for ${name} in ~/.kit/mcp-tokens.json (chmod 0o600)`,
  );
  const status = await orchestrator.statusForMcp(name, declared ?? null);
  console.log(`${c.dim}Status: ${status.status}${c.reset}`);
  return true;
}

async function clearMcp(
  name: string | undefined,
  clearMcpToken: Orchestrator["clearMcpToken"],
): Promise<boolean> {
  if (!name) return usage("Usage: kit mcp clear <name>");
  await clearMcpToken(name);
  console.log(`${c.green}✓${c.reset} Cleared token for ${name}`);
  return true;
}

/**
 * The sub-command is the first word that is not a flag: `kit mcp --read-only` is the stdio server
 * in read-only mode, not an unknown sub-command. Reading argv[3] printed the usage instead.
 */
export async function cmdMcp(): Promise<boolean> {
  const sub = process.argv.slice(3).find((arg) => !arg.startsWith("-"));

  // An MCP client launches `kit mcp` and speaks the stdio transport: no sub-command and a non-TTY
  // stdin. Start the server in that case. Interactive use (TTY) or any explicit sub falls through.
  if (!sub && !process.stdin.isTTY) {
    await startMcpServer();
    return true;
  }
  if (sub === "web") return runWebWizard();

  const config = await loadConfig(resolveConfigPath()).catch(() => null);
  const mcpConfig = config?.mcp;
  const orchestrator = await import("../mcp-orchestrator.js");
  const name = process.argv[4];

  if (!sub || sub === "list" || sub === "status") return listMcp(orchestrator.statusAll, mcpConfig);
  if (sub === "auth") return authMcp(name, mcpConfig);
  if (sub === "set-token") return setTokenMcp(name, mcpConfig, orchestrator);
  if (sub === "clear") return clearMcp(name, orchestrator.clearMcpToken);
  return usage(
    "Usage: kit mcp [web | list | status | auth <name> | set-token <name> | clear <name>]",
  );
}
