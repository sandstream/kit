/**
 * Agent / MCP / hook auditing — kit-native baseline.
 *
 * Coding-agent config and git hooks are an under-watched supply-chain surface:
 * `.claude.json` / `.mcp.json` / editor MCP configs routinely carry MCP server
 * definitions (and, as we've seen, plaintext API keys), and git hooks run
 * arbitrary shell on every commit/checkout. This audits both, deterministically:
 *
 *  - secrets-in-config : plaintext API keys/tokens committed into an agent/MCP
 *                        config (reuses kit's `findSecrets`; the `.claude.json`
 *                        sk_live leak class).
 *  - cleartext-mcp     : an MCP server pointed at a plain `http://` URL.
 *  - suspicious-hook   : a git hook body with a malware-shaped line (pipe-to-shell,
 *                        base64-decode-to-shell, `/dev/tcp` reverse shell, eval of a
 *                        command substitution).
 *
 * Pure analyzers (string in → findings out); `runAgentAudit` is the file-reading wrapper.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { findSecrets } from "./utils/redactSecrets.js";

/** Plaintext secrets in an agent/MCP config file. */
export function auditConfigSecrets(content: string): { label: string; preview: string }[] {
  return findSecrets(content);
}

/** MCP servers pointed at a cleartext `http://` URL (parsed from a config object). */
export function auditMcpServers(json: string): string[] {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return [];
  }
  const out: string[] = [];
  // Claude/Cursor/VSCode all nest servers under `mcpServers` (or `servers`).
  const containers = [
    (obj as { mcpServers?: Record<string, unknown> })?.mcpServers,
    (obj as { servers?: Record<string, unknown> })?.servers,
    (obj as { mcp?: Record<string, unknown> })?.mcp, // OpenCode nests servers under `mcp`
  ].filter((c): c is Record<string, unknown> => !!c && typeof c === "object");
  for (const servers of containers) {
    for (const [name, def] of Object.entries(servers)) {
      const url = (def as { url?: string })?.url;
      if (typeof url === "string" && /^http:\/\//i.test(url)) out.push(`${name} → ${url}`);
    }
  }
  return out;
}

const SUSPICIOUS_HOOK_PATTERNS: { re: RegExp; why: string }[] = [
  {
    re: /(curl|wget)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
    why: "pipes a download straight into a shell",
  },
  {
    re: /base64\s+(-d|--decode|-D)\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
    why: "base64-decodes into a shell",
  },
  { re: /\/dev\/tcp\//, why: "opens a raw TCP socket (reverse-shell shape)" },
  { re: /eval\s+"?\$\(/, why: "evals a command substitution" },
];

/** Malware-shaped lines in a hook body. Returns the reasons matched. */
export function auditHookBody(content: string): string[] {
  return SUSPICIOUS_HOOK_PATTERNS.filter((p) => p.re.test(content)).map((p) => p.why);
}

/** Lowercased basename of a command path (handles /usr/bin/node, node.exe). */
function baseCmd(command: string): string {
  return (command.split(/[\\/]/).pop() ?? command).replace(/\.exe$/i, "").toLowerCase();
}

/** Interpreters that execute INLINE code via a flag — abnormal for a persistent MCP server. */
const INLINE_EVAL: Record<string, RegExp> = {
  node: /^(-e|--eval)$/,
  bun: /^(-e|--eval)$/,
  deno: /^eval$/,
  python: /^-c$/,
  python3: /^-c$/,
  ruby: /^-e$/,
  perl: /^-e$/,
  sh: /^-c$/,
  bash: /^-c$/,
  zsh: /^-c$/,
};

export interface StdioMcpFinding {
  server: string;
  severity: "high";
  why: string;
}

/**
 * A *stdio* MCP server runs a local `command` (+ args) on every agent startup.
 * We do NOT flag the common-and-legitimate `npx <pkg>` shape (that would warn on
 * almost every config — noise is the #1 reason security tooling gets ignored).
 * We flag only the unambiguous abuse shapes: a malware-pattern command line, or
 * an interpreter running INLINE code (a real MCP server is a program, not a
 * `node -e "…"` / `sh -c "…"` one-liner).
 */
export function auditMcpStdio(json: string): StdioMcpFinding[] {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return [];
  }
  const containers = [
    (obj as { mcpServers?: Record<string, unknown> })?.mcpServers,
    (obj as { servers?: Record<string, unknown> })?.servers,
    (obj as { mcp?: Record<string, unknown> })?.mcp, // OpenCode nests servers under `mcp`
  ].filter((c): c is Record<string, unknown> => !!c && typeof c === "object");
  const out: StdioMcpFinding[] = [];
  for (const servers of containers) {
    for (const [name, def] of Object.entries(servers)) {
      const command = (def as { command?: unknown })?.command;
      if (typeof command !== "string" || !command) continue; // url-based: handled by auditMcpServers
      const rawArgs = (def as { args?: unknown }).args;
      const argv = Array.isArray(rawArgs)
        ? rawArgs.filter((a): a is string => typeof a === "string")
        : [];
      const full = [command, ...argv].join(" ");
      const malware = SUSPICIOUS_HOOK_PATTERNS.find((p) => p.re.test(full));
      if (malware) {
        out.push({ server: name, severity: "high", why: malware.why });
        continue;
      }
      const cmd = baseCmd(command);
      const evalRe = INLINE_EVAL[cmd];
      if (evalRe && argv.some((a) => evalRe.test(a))) {
        out.push({ server: name, severity: "high", why: `runs inline code via \`${cmd}\`` });
      }
    }
  }
  return out;
}

function result(
  name: string,
  status: SecurityCheckResult["status"],
  detail: string,
  category: SecurityCheckResult["category"],
  severity?: SecurityCheckResult["severity"],
  suggestion?: string,
): SecurityCheckResult {
  return { category, name, status, detail, severity, suggestion };
}

const CONFIG_FILES = [
  ".claude.json",
  ".mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  // OpenCode (project config carries an `mcp` block) + Codex CLI. secrets-in-config
  // is format-agnostic (findSecrets reads raw text); the JSON-shaped MCP checks
  // simply no-op on the TOML files.
  "opencode.json",
  "opencode.jsonc",
  ".codex/config.toml",
  ".codex/config.json",
];

const HOOK_DIRS = [".git/hooks", ".githooks", ".husky"];

/** Audit agent/MCP configs + git hooks under `cwd`. Read-only; fail-open per file. */
export function runAgentAudit(cwd: string): SecurityCheckResult[] {
  const out: SecurityCheckResult[] = [];
  let scannedConfigs = 0;
  let scannedHooks = 0;

  for (const rel of CONFIG_FILES) {
    const path = resolve(cwd, rel);
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    scannedConfigs++;
    const secrets = auditConfigSecrets(content);
    if (secrets.length > 0) {
      const kinds = [...new Set(secrets.map((s) => s.label))].join(", ");
      out.push(
        result(
          `secret in ${rel}`,
          "fail",
          `${secrets.length} plaintext secret(s) (${kinds}) in an agent config — e.g. ${secrets[0].preview}`,
          "secrets",
          "critical",
          `move it to a vault/env and gitignore ${rel}`,
        ),
      );
    }
    const cleartext = auditMcpServers(content);
    if (cleartext.length > 0) {
      out.push(
        result(
          `cleartext MCP in ${rel}`,
          "warn",
          `${cleartext.length} MCP server(s) on http://: ${cleartext.slice(0, 3).join("; ")}`,
          "exposure",
          "medium",
          "use https:// MCP endpoints",
        ),
      );
    }
    for (const s of auditMcpStdio(content)) {
      out.push(
        result(
          `risky MCP server "${s.server}" in ${rel}`,
          "fail",
          `stdio MCP server ${s.why} — it executes on every agent startup`,
          "exposure",
          s.severity,
          "verify this MCP server's command; an inline/obfuscated command is a backdoor shape",
        ),
      );
    }
  }

  for (const dir of HOOK_DIRS) {
    const dpath = resolve(cwd, dir);
    if (!existsSync(dpath)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dpath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".sample")) continue;
      const hpath = join(dpath, entry);
      try {
        if (!statSync(hpath).isFile()) continue;
        const body = readFileSync(hpath, "utf8");
        scannedHooks++;
        const reasons = auditHookBody(body);
        if (reasons.length > 0) {
          out.push(
            result(
              `suspicious hook ${dir}/${entry}`,
              "fail",
              `hook ${reasons.join("; ")}`,
              "exposure",
              "high",
              "review the hook; a compromised hook runs on every git operation",
            ),
          );
        }
      } catch {
        continue;
      }
    }
  }

  if (out.length === 0) {
    out.push(
      result(
        "agent-audit",
        "pass",
        `no issues in ${scannedConfigs} agent config(s) + ${scannedHooks} hook(s)`,
        "exposure",
      ),
    );
  }
  return out;
}
