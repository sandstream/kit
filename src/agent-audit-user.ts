/**
 * User-level agent surfaces: `~/.claude/skills`, `~/.claude/commands`, `~/.claude/agents` and
 * `~/.claude/CLAUDE.md`. Claude Code loads them into every session in every project, and nothing
 * in a project's history records a change to them: they are often synced from another repository
 * by a script, or rewritten by an agent. `runAgentAudit` reads the project's own `.claude/` only.
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

/** `~/…` for a path under `home`, so output names the file without the user's home path. */
export function shownUnderHome(home: string, abs: string): string {
  return `~/${relative(home, abs).split(sep).join("/")}`;
}

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

/** The user-level instruction files: `~/.claude/CLAUDE.md` and every `.md` in the user dirs. */
export function userInstructionFiles(home: string): string[] {
  const files: string[] = [];
  const top = join(home, ".claude", "CLAUDE.md");
  if (existsSync(top)) files.push(top);
  for (const { dir } of USER_AGENT_DIRS) filesUnder(join(home, dir), MD, MAX_DEPTH, files);
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

function surfaces(home: string): { rows: SecurityCheckResult[]; scanned: number } {
  const rows: SecurityCheckResult[] = [];
  let scanned = 0;
  for (const { dir, label } of USER_AGENT_DIRS) {
    const files: string[] = [];
    filesUnder(join(home, dir), SCAN_EXTS, MAX_DEPTH, files);
    for (const f of files) {
      // One descriptor for the check and the read (fstat on it), so the file cannot be swapped.
      const body = readInstructionFile(f);
      if (body === null) continue;
      scanned++;
      rows.push(...surfaceRows(shownUnderHome(home, f), label, body));
    }
  }
  return { rows, scanned };
}

function instructionRows(home: string): { rows: SecurityCheckResult[]; read: number } {
  const rows: SecurityCheckResult[] = [];
  let read = 0;
  for (const file of userInstructionFiles(home)) {
    const text = readInstructionFile(file);
    if (text === null) continue;
    read++;
    const shown = shownUnderHome(home, file);
    for (const f of scanInstructionText(shown, text)) {
      rows.push({
        category: "exposure",
        name: `instruction finding in ${shown}:${f.line}`,
        // A warning to read, not a failure: pattern rules cannot tell a line that quotes an attack
        // to warn against it from the attack (Anthropic's own import-memory skill trips one).
        status: "warn",
        severity: "medium",
        detail: `[${f.rule}] ${f.excerpt} — loaded into every Claude Code session on this machine`,
        suggestion: `read ${shown}; if you did not write this line, find what synced or edited the file`,
      });
    }
  }
  return { rows, read };
}

/**
 * Audit the user-level agent surfaces under `home`. When `root` is `home`, the project audit has
 * already read these dirs, so this reports nothing rather than reporting them twice.
 */
export function runUserAgentAudit(root: string, home: string): SecurityCheckResult[] {
  if (sameDir(root, home)) return [];
  const s = surfaces(home);
  const instructions = instructionRows(home);
  const rows = [...s.rows, ...instructions.rows];
  if (rows.length === 0 && (s.scanned > 0 || instructions.read > 0)) {
    rows.push({
      category: "exposure",
      name: "user-level agent surfaces",
      status: "pass",
      detail: `no issues in ${s.scanned} file(s) under ~/.claude/{skills,commands,agents}, ${instructions.read} read as instructions`,
    });
  }
  return rows;
}
