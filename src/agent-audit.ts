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
 *  - settings-command  : the same malware shapes in a Claude `settings.json`
 *                        `statusLine.command` or `hooks[].command` — exec surfaces
 *                        declared inline rather than as a hook file.
 *  - agent-surface     : secrets / inline-MCP / malware shapes in Claude's other
 *                        code surfaces — `.claude/commands`, `.claude/agents`,
 *                        `.claude/skills`, `.claude/plugins`.
 *
 * Pure analyzers (string in → findings out); `runAgentAudit` is the file-reading wrapper.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, relative, extname } from "node:path";
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

/**
 * Code-execution command strings declared *inside* a Claude `settings.json`:
 *  - `statusLine.command` — a shell command run on every status-line render.
 *  - `hooks.<event>[].hooks[].command` — run on each matched lifecycle event.
 * kit already scans git-hook *files* (`HOOK_DIRS`) for malware, but these
 * in-settings command strings are the same execution surface and were previously
 * unscanned. We reuse the same malware patterns; kit's own `<node> <cli.js> …
 * memory hook` entries are inert here (no malware shape), so no false positive.
 */
export function auditSettingsCommands(json: string): { where: string; why: string }[] {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return [];
  }
  const out: { where: string; why: string }[] = [];
  const check = (cmd: unknown, where: string): void => {
    if (typeof cmd !== "string" || !cmd) return;
    for (const why of auditHookBody(cmd)) out.push({ where, why });
  };
  const statusLine = (obj as { statusLine?: unknown })?.statusLine;
  if (statusLine && typeof statusLine === "object") {
    check((statusLine as { command?: unknown }).command, "statusLine.command");
  }
  const hooks = (obj as { hooks?: unknown })?.hooks;
  if (hooks && typeof hooks === "object") {
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        const hs = (g as { hooks?: unknown })?.hooks;
        if (!Array.isArray(hs)) continue;
        for (const h of hs) check((h as { command?: unknown })?.command, `hooks.${event}`);
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

/**
 * Claude Code's other code/instruction surfaces: custom slash commands, subagents,
 * skills, and installed plugins. Each can carry a script the agent runs, an MCP
 * server it launches, or a plaintext secret. We scan their files for the same
 * malware shapes, secrets, and MCP declarations as the configs above.
 */
const AGENT_DIRS: { dir: string; label: string }[] = [
  { dir: ".claude/commands", label: "slash-command" },
  { dir: ".claude/agents", label: "subagent" },
  { dir: ".claude/skills", label: "skill" },
  { dir: ".claude/plugins", label: "plugin" },
];

const SCAN_EXTS = new Set([
  ".md",
  ".json",
  ".jsonc",
  ".sh",
  ".bash",
  ".zsh",
  ".js",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".toml",
  ".txt",
]);
const MAX_SCAN_BYTES = 512 * 1024;

/** Collect scannable files under `dir`, bounded in depth (defends against a deep/looped tree). */
function collectFiles(dir: string, maxDepth: number, acc: string[]): void {
  if (maxDepth < 0 || acc.length > 2000) return;
  let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, maxDepth - 1, acc);
    else if (e.isFile() && SCAN_EXTS.has(extname(e.name).toLowerCase())) acc.push(p);
  }
}

/** Scan Claude's command/agent/skill/plugin dirs for secrets, inline MCP, and malware shapes. */
function scanAgentDirs(cwd: string): { results: SecurityCheckResult[]; scanned: number } {
  const out: SecurityCheckResult[] = [];
  let scanned = 0;
  for (const { dir, label } of AGENT_DIRS) {
    const dpath = resolve(cwd, dir);
    if (!existsSync(dpath)) continue;
    const files: string[] = [];
    collectFiles(dpath, 5, files);
    for (const fpath of files) {
      let body: string;
      try {
        if (statSync(fpath).size > MAX_SCAN_BYTES) continue;
        body = readFileSync(fpath, "utf8");
      } catch {
        continue;
      }
      scanned++;
      const rel = relative(cwd, fpath);
      const secrets = auditConfigSecrets(body);
      if (secrets.length > 0) {
        const kinds = [...new Set(secrets.map((s) => s.label))].join(", ");
        out.push(
          result(
            `secret in ${label} ${rel}`,
            "fail",
            `${secrets.length} plaintext secret(s) (${kinds}) in a Claude ${label} — e.g. ${secrets[0].preview}`,
            "secrets",
            "critical",
            `move it to a vault/env and gitignore ${rel}`,
          ),
        );
      }
      const ext = extname(fpath).toLowerCase();
      if (ext === ".json" || ext === ".jsonc") {
        for (const s of auditMcpStdio(body)) {
          out.push(
            result(
              `risky MCP server "${s.server}" in ${label} ${rel}`,
              "fail",
              `a ${label} declares a stdio MCP server that ${s.why} — it executes when the ${label} loads`,
              "exposure",
              s.severity,
              "verify this MCP server's command; an inline/obfuscated command is a backdoor shape",
            ),
          );
        }
      }
      const reasons = auditHookBody(body);
      if (reasons.length > 0) {
        out.push(
          result(
            `malware-shaped ${label} ${rel}`,
            "warn",
            `a Claude ${label} contains a command that ${reasons.join("; ")} — verify it is intentional`,
            "exposure",
            "medium",
            `review ${rel}; a ${label} can run shell when invoked`,
          ),
        );
      }
    }
  }
  return { results: out, scanned };
}

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
    for (const c of auditSettingsCommands(content)) {
      out.push(
        result(
          `malware-shaped command in ${rel} (${c.where})`,
          "fail",
          `${c.where} ${c.why} — this command executes automatically`,
          "exposure",
          "high",
          `review the ${c.where} command in ${rel}; it runs on every matching event, like a hook`,
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

  const agent = scanAgentDirs(cwd);
  out.push(...agent.results);

  if (out.length === 0) {
    out.push(
      result(
        "agent-audit",
        "pass",
        `no issues in ${scannedConfigs} agent config(s) + ${scannedHooks} hook(s) + ${agent.scanned} command/agent/skill/plugin file(s)`,
        "exposure",
      ),
    );
  }
  return out;
}
