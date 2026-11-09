/**
 * User-level agent surfaces, loaded into every session in every project, where nothing in a
 * project's history records a change: they are often synced from another repository by a script,
 * or rewritten by an agent. `runAgentAudit` reads the project's own `.claude/` only.
 *   - Claude Code: `~/.claude/skills`, `commands`, `agents` and `~/.claude/CLAUDE.md`.
 *   - Codex (developers.openai.com/codex, 2026-11-08): global instructions in the Codex home
 *     (`$CODEX_HOME`, default `~/.codex`) as `AGENTS.override.md` or else `AGENTS.md`; user skills in
 *     `~/.agents/skills`, and in `<codex home>/skills` where older Codex versions installed them.
 *     Both instruction files are read: the one Codex skips today loads once the other is removed.
 *
 * Two passes, both read-only:
 *   - the project audit's secret, malware and inline-MCP analyzers, on every file in the user dirs;
 *   - `kit triage instructions`' rules (`scanInstructionText`) on every markdown file there, since
 *     each of those files is text the agent takes as an instruction. A hit is a warning: on the
 *     first real machine it ran on, its one hit was a vendor skill quoting an injection phrase in
 *     order to forbid it.
 *
 * Plugins (`~/.claude/plugins`) are left out: that directory holds marketplace caches of other
 * repositories, which `kit triage` covers when they are installed.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { auditConfigSecrets, auditHookBody, auditMcpStdio } from "./agent-audit.js";
import { readInstructionFile, scanInstructionText } from "./instruction-scan.js";

export const USER_AGENT_DIRS = [
  { dir: join(".claude", "skills"), label: "user skill" },
  { dir: join(".claude", "commands"), label: "user command" },
  { dir: join(".claude", "agents"), label: "user subagent" },
];

/** One user-level directory: where it is, what it holds, and how a path in it is shown. */
export interface UserSurface {
  dir: string;
  label: string;
  /** Display prefix for the directory: `~/…` or `$CODEX_HOME/…`, never the home path. */
  shown: string;
  /** A Claude dir, which the project audit already reads when run from the home directory. */
  claude: boolean;
}

/** The Codex home and how it is shown. Pure. */
export function codexHome(
  home: string,
  env: Record<string, unknown>,
): { dir: string; shown: string } {
  const set = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim() !== "";
  return set
    ? { dir: String(env.CODEX_HOME), shown: "$CODEX_HOME" }
    : { dir: join(home, ".codex"), shown: "~/.codex" };
}

/** Every user-level agent directory kit reads, for Claude Code and Codex. Pure. */
export function userSurfaces(home: string, env: Record<string, unknown>): UserSurface[] {
  const codex = codexHome(home, env);
  return [
    ...USER_AGENT_DIRS.map(({ dir, label }) => ({
      dir: join(home, dir),
      label,
      shown: `~/${dir.split(sep).join("/")}`,
      claude: true,
    })),
    {
      dir: join(home, ".agents", "skills"),
      label: "Codex user skill",
      shown: "~/.agents/skills",
      claude: false,
    },
    {
      dir: join(codex.dir, "skills"),
      label: "Codex user skill",
      shown: `${codex.shown}/skills`,
      claude: false,
    },
  ];
}

/** The path `abs` inside `surface`, shown from its prefix with forward slashes. Pure. */
export function shownIn(prefix: string, base: string, abs: string): string {
  const rel = relative(base, abs).split(sep).join("/");
  return rel ? `${prefix}/${rel}` : prefix;
}
const MAX_DEPTH = 5;
const MAX_FILES = 2000;
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
  ".ts",
  ".py",
  ".rb",
  ".toml",
  ".txt",
]);

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Files under one user dir whose extension is in `exts`, bounded. Symlinked dirs are not walked. */
function filesUnder(dir: string, exts: Set<string>, depth: number, acc: string[]): void {
  if (depth < 0 || acc.length >= MAX_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, exts, depth - 1, acc);
    else if ((e.isFile() || e.isSymbolicLink()) && exts.has(extname(e.name).toLowerCase()))
      acc.push(p);
  }
}

const MD = new Set([".md"]);

/**
 * The user-level instruction files, each with how it is shown: `~/.claude/CLAUDE.md`, Codex's
 * `AGENTS.override.md` and `AGENTS.md`, and every `.md` in the user dirs.
 */
export function userInstructionFiles(
  home: string,
  env: Record<string, unknown> = {},
  claude = true,
): { abs: string; shown: string }[] {
  const codex = codexHome(home, env);
  const tops = [
    ...(claude ? [{ abs: join(home, ".claude", "CLAUDE.md"), shown: "~/.claude/CLAUDE.md" }] : []),
    ...["AGENTS.override.md", "AGENTS.md"].map((n) => ({
      abs: join(codex.dir, n),
      shown: `${codex.shown}/${n}`,
    })),
  ];
  const files = tops.filter((t) => existsSync(t.abs));
  for (const surface of userSurfaces(home, env)) {
    if (surface.claude && !claude) continue;
    const found: string[] = [];
    filesUnder(surface.dir, MD, MAX_DEPTH, found);
    files.push(...found.map((abs) => ({ abs, shown: shownIn(surface.shown, surface.dir, abs) })));
  }
  return files;
}

/** One file's rows from the project audit's analyzers. Pure. */
export function surfaceRows(shown: string, label: string, body: string): SecurityCheckResult[] {
  const rows: SecurityCheckResult[] = [];
  const secrets = auditConfigSecrets(body);
  if (secrets.length > 0) {
    const kinds = [...new Set(secrets.map((x) => x.label))].join(", ");
    rows.push({
      category: "secrets",
      name: `secret in ${label} ${shown}`,
      status: "fail",
      severity: "critical",
      detail: `${secrets.length} plaintext secret(s) (${kinds}) in a ${label} — e.g. ${secrets[0].preview}`,
      suggestion: `move it to a vault or env; a ${label} is loaded into every session`,
    });
  }
  if (/\.jsonc?$/i.test(shown))
    for (const m of auditMcpStdio(body))
      rows.push({
        category: "exposure",
        name: `risky MCP server "${m.server}" in ${label} ${shown}`,
        status: "fail",
        severity: m.severity,
        detail: `a ${label} declares a stdio MCP server that ${m.why} — it executes when the ${label} loads`,
        suggestion:
          "verify this MCP server's command; an inline or obfuscated command is a backdoor shape",
      });
  const reasons = auditHookBody(body);
  if (reasons.length > 0)
    rows.push({
      category: "exposure",
      name: `malware-shaped ${label} ${shown}`,
      status: "warn",
      severity: "medium",
      detail: `a ${label} contains a command that ${reasons.join("; ")} — verify it is intentional`,
      suggestion: `review ${shown}; a ${label} can run shell when invoked`,
    });
  return rows;
}

function surfaces(
  home: string,
  env: Record<string, unknown>,
  claude: boolean,
): { rows: SecurityCheckResult[]; scanned: number } {
  const rows: SecurityCheckResult[] = [];
  let scanned = 0;
  for (const surface of userSurfaces(home, env)) {
    if (surface.claude && !claude) continue;
    const files: string[] = [];
    filesUnder(surface.dir, SCAN_EXTS, MAX_DEPTH, files);
    for (const f of files) {
      // One descriptor for the check and the read (fstat on it), so the file cannot be swapped.
      const body = readInstructionFile(f);
      if (body === null) continue;
      scanned++;
      rows.push(...surfaceRows(shownIn(surface.shown, surface.dir, f), surface.label, body));
    }
  }
  return { rows, scanned };
}

function instructionRows(
  home: string,
  env: Record<string, unknown>,
  claude: boolean,
): { rows: SecurityCheckResult[]; read: number } {
  const rows: SecurityCheckResult[] = [];
  let read = 0;
  for (const { abs, shown } of userInstructionFiles(home, env, claude)) {
    const text = readInstructionFile(abs);
    if (text === null) continue;
    read++;
    for (const f of scanInstructionText(shown, text)) {
      rows.push({
        category: "exposure",
        name: `instruction finding in ${shown}:${f.line}`,
        // A warning to read, not a failure: pattern rules cannot tell a line that quotes an attack
        // to warn against it from the attack (Anthropic's own import-memory skill trips one).
        status: "warn",
        severity: "medium",
        detail: `[${f.rule}] ${f.excerpt} — loaded into every agent session on this machine`,
        suggestion: `read ${shown}; if you did not write this line, find what synced or edited the file`,
      });
    }
  }
  return { rows, read };
}

/**
 * Audit the user-level agent surfaces under `home`. When `root` is `home`, the project audit has
 * already read the Claude dirs, so only the Codex ones are read rather than reporting twice.
 */
export function runUserAgentAudit(
  root: string,
  home: string,
  env: Record<string, unknown> = {},
): SecurityCheckResult[] {
  const claude = !sameDir(root, home);
  const s = surfaces(home, env, claude);
  const instructions = instructionRows(home, env, claude);
  const rows = [...s.rows, ...instructions.rows];
  if (rows.length === 0 && (s.scanned > 0 || instructions.read > 0)) {
    rows.push({
      category: "exposure",
      name: "user-level agent surfaces",
      status: "pass",
      detail: `no issues in ${s.scanned} file(s) in the Claude Code and Codex user dirs, ${instructions.read} read as instructions`,
    });
  }
  return rows;
}
