/**
 * Code-loading environment variables in the agent's environment.
 *
 * One exported variable can put a file inside every process of a runtime, the agent included:
 *   BUN_OPTIONS / NODE_OPTIONS  - `--preload`, `--require`/`-r`, `--import`, `--loader`
 *   LD_PRELOAD                  - shared libraries the dynamic linker loads first (Linux)
 *   DYLD_INSERT_LIBRARIES       - the same on macOS
 * That reaches past every install and plugin gate: nothing is installed, a line is exported.
 *
 * kit cannot tell a preload the user chose from one a package or an agent planted, so this only
 * names what is loaded and from where. It reads the given environment and the `env` block of Claude
 * Code's settings files; it never reads or runs the loaded file.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

const LOADER_FLAGS = new Set([
  "--preload",
  "--require",
  "-r",
  "--import",
  "--loader",
  "--experimental-loader",
]);
const OPTION_VARS = ["BUN_OPTIONS", "NODE_OPTIONS"];
const LIBRARY_VARS: { name: string; split: RegExp }[] = [
  { name: "LD_PRELOAD", split: /[\s:]+/ }, // ld.so accepts spaces or colons
  { name: "DYLD_INSERT_LIBRARIES", split: /:+/ },
];

export interface PreloadFinding {
  variable: string;
  loads: string[];
}

const QUOTES = new Set(["'", '"']);

function unquote(s: string): string {
  const q = s[0];
  return s.length > 1 && QUOTES.has(q) && s.endsWith(q) ? s.slice(1, -1) : s;
}

/** Files a `BUN_OPTIONS`/`NODE_OPTIONS` value loads, in both `--flag=x` and `--flag x` forms. */
export function loadedByOptions(value: string): string[] {
  const tokens = value.split(/\s+/).filter(Boolean).map(unquote);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const eq = t.indexOf("=");
    if (eq > 0 && LOADER_FLAGS.has(t.slice(0, eq))) out.push(unquote(t.slice(eq + 1)));
    else if (LOADER_FLAGS.has(t) && i + 1 < tokens.length) out.push(tokens[++i]);
  }
  return out.filter(Boolean);
}

/** Every code-loading variable set in `env`, with the files it loads. */
export function auditPreloadEnv(env: Record<string, unknown>): PreloadFinding[] {
  const out: PreloadFinding[] = [];
  for (const name of OPTION_VARS) {
    const v = env[name];
    if (typeof v !== "string") continue;
    const loads = loadedByOptions(v);
    if (loads.length > 0) out.push({ variable: name, loads });
  }
  for (const { name, split } of LIBRARY_VARS) {
    const v = env[name];
    if (typeof v !== "string") continue;
    const loads = v.split(split).filter(Boolean);
    if (loads.length > 0) out.push({ variable: name, loads });
  }
  return out;
}

/** The `env` block of a Claude Code settings file, or null when absent or unreadable. */
function settingsEnv(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const env = (JSON.parse(readFileSync(path, "utf8")) as { env?: unknown })?.env;
    return env && typeof env === "object" ? (env as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** One warn row per code-loading variable, from the process environment and Claude settings. */
export function runAgentPreload(
  root: string,
  home: string,
  env: Record<string, unknown>,
): SecurityCheckResult[] {
  const project = join(root, ".claude", "settings.json");
  const user = join(home, ".claude", "settings.json");
  const sources: { where: string; env: Record<string, unknown> | null }[] = [
    { where: "process environment", env },
    { where: ".claude/settings.json", env: settingsEnv(project) },
    {
      where: ".claude/settings.local.json",
      env: settingsEnv(join(root, ".claude", "settings.local.json")),
    },
    // Run from the home directory, the user file is the project file: report it once.
    { where: "~/.claude/settings.json", env: sameDir(root, home) ? null : settingsEnv(user) },
  ];
  const rows: SecurityCheckResult[] = [];
  for (const s of sources) {
    if (!s.env) continue;
    for (const f of auditPreloadEnv(s.env)) {
      rows.push({
        category: "exposure",
        name: `${f.variable} loads code (${s.where})`,
        status: "warn",
        severity: "medium",
        detail: `every process that reads ${f.variable} runs this first: ${f.loads.join(", ")}`,
        suggestion:
          "confirm you set this and that the file is yours; kit cannot tell a chosen preload from a planted one",
      });
    }
  }
  return rows;
}
