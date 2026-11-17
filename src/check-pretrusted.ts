/**
 * Whether an agent tool already trusts this repository, read from the files the tool keeps.
 *
 * An agent's "do you trust this folder?" prompt is what stops a freshly cloned repository's
 * project hooks, `.codex/hooks.json` and MCP servers from loading. Agent managers such as Orca
 * write that trust into each agent's own config for every repository they open, so the prompt
 * never appears and kit's agent-config rows are the only check before that code runs
 * (kit-research `orca-ade-vs-kit`). Read-only: the row names the tool and the file, and prints
 * nothing else from either file.
 *
 *   - Claude Code: `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`),
 *     `projects[<path>].hasTrustDialogAccepted === true`.
 *   - Codex: `~/.codex/config.toml` (or `$CODEX_HOME`), `[projects."<path>"]` with
 *     `trust_level = "trusted"`.
 *
 * Info, not warn: the file does not say whether the user or a tool wrote the flag, and accepting
 * the prompt once is the normal state of every repository a user works in, so a warning would
 * fire on almost every repository with no remedy, and fail `kit check --strict`.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { codexHome } from "./agent-audit-user.js";

/** `~/.claude.json` grows with history; anything larger than this is not read. */
const MAX_BYTES = 64 * 1024 * 1024;

function readBounded(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** A path as a comparison key: forward slashes, no trailing slash, case-folded on Windows. Pure. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const k = p.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");
  return platform === "win32" ? k.toLowerCase() : k;
}

/** The keys this repository can appear under: as given, resolved, and with links resolved. */
function rootKeys(root: string): Set<string> {
  const paths = [root, resolve(root)];
  try {
    paths.push(realpathSync(root));
  } catch {
    // a missing root still matches by its given path
  }
  return new Set(paths.map((p) => pathKey(p)));
}

/** True when `~/.claude.json` marks one of `keys` as trust-accepted. Pure. */
export function claudeTrusts(body: string, keys: Set<string>): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(body);
  } catch {
    return false;
  }
  const projects = (obj as { projects?: unknown })?.projects;
  if (!projects || typeof projects !== "object") return false;
  return Object.entries(projects as Record<string, unknown>).some(
    ([path, p]) =>
      keys.has(pathKey(path)) &&
      (p as { hasTrustDialogAccepted?: unknown })?.hasTrustDialogAccepted === true,
  );
}

/** The path in a `[projects."<path>"]` header, or null for any other line. Pure. */
function projectHeader(line: string): string | null {
  const m = /^\s*\[\s*projects\s*\.\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(#.*)?$/.exec(line);
  if (!m) return null;
  if (m[1].startsWith("'")) return m[1].slice(1, -1);
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
}

/** True when Codex's `config.toml` sets `trust_level = "trusted"` for one of `keys`. Pure. */
export function codexTrusts(body: string, keys: Set<string>): boolean {
  let current: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      const path = projectHeader(line);
      current = path !== null && keys.has(pathKey(path)) ? path : null;
    } else if (current !== null && /^\s*trust_level\s*=\s*["']trusted["']\s*(#.*)?$/.test(line)) {
      return true;
    }
  }
  return false;
}

/** One info row naming each agent tool that has pre-trusted `root`; none when no tool has. */
export function checkPreTrusted(
  root: string,
  home: string,
  env: Record<string, unknown> = {},
): SecurityCheckResult[] {
  const keys = rootKeys(root);
  const claudeDir = typeof env.CLAUDE_CONFIG_DIR === "string" && env.CLAUDE_CONFIG_DIR.trim();
  const claude = claudeDir
    ? { file: join(claudeDir, ".claude.json"), shown: "$CLAUDE_CONFIG_DIR/.claude.json" }
    : { file: join(home, ".claude.json"), shown: "~/.claude.json" };
  const codex = codexHome(home, env);
  const tools: string[] = [];
  const claudeBody = readBounded(claude.file);
  if (claudeBody !== null && claudeTrusts(claudeBody, keys))
    tools.push(`Claude Code (${claude.shown}, hasTrustDialogAccepted)`);
  const codexBody = readBounded(join(codex.dir, "config.toml"));
  if (codexBody !== null && codexTrusts(codexBody, keys))
    tools.push(`Codex (${codex.shown}/config.toml, trust_level = "trusted")`);
  if (tools.length === 0) return [];
  return [
    {
      category: "exposure",
      name: "repository pre-trusted by an agent tool",
      status: "pass",
      detail: `info: ${tools.join("; ")}. The agent loads this repository's project hooks and MCP servers without asking; kit's agent-config rows are the check before they run`,
      suggestion:
        "if you did not accept the trust prompt yourself, a tool (an agent manager such as Orca) wrote it; review this repository's agent config before the next agent session",
    },
  ];
}
