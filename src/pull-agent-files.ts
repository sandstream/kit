/**
 * Files an agent or editor executes or obeys, recognised by path.
 *
 * A pull that adds a `SessionStart` hook, an MCP server, a folder-open editor task or an
 * `AGENTS.md` line telling the agent to run a script first is how a worm with stolen Git
 * credentials spreads from one machine to the next (kit-research `strutil-core-gem-worm-vs-kit`).
 * `kit security verify-pull` printed "No security concerns" for exactly that pull. The paths are
 * the ones the agent audit and the instruction scan already read; this module only names them
 * for a pulled range. Paths are git paths, always `/`-separated. Pure.
 */

/** Instruction files, read wherever they sit (the instruction scan's names). */
const INSTRUCTION_NAMES = new Set([
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "GEMINI.md",
  "SKILL.md",
  ".cursorrules",
  ".windsurfrules",
  "copilot-instructions.md",
]);

/** Exact paths and what running them means. */
const EXACT: Record<string, string> = {
  ".claude/settings.json": "agent settings (hooks, status line)",
  ".claude/settings.local.json": "agent settings (hooks, status line)",
  ".gemini/settings.json": "agent settings (hooks, MCP servers)",
  ".claude.json": "MCP servers",
  ".mcp.json": "MCP servers",
  ".cursor/mcp.json": "MCP servers",
  ".vscode/mcp.json": "MCP servers",
  "opencode.json": "agent config (MCP servers)",
  "opencode.jsonc": "agent config (MCP servers)",
  ".codex/config.toml": "agent config (MCP servers)",
  ".vscode/tasks.json": "editor tasks (can run when the folder opens)",
  ".devcontainer.json": "dev container (runs commands on create)",
  ".devcontainer/devcontainer.json": "dev container (runs commands on create)",
  ".envrc": "direnv (runs on cd)",
};

/** Directory prefixes and what their files are. */
const PREFIXES: [string, string][] = [
  [".claude/commands/", "agent command"],
  [".claude/agents/", "subagent"],
  [".claude/skills/", "agent skill"],
  [".claude/hooks/", "agent hook script"],
  [".agents/", "agent skill"],
  [".cursor/rules/", "agent rules"],
  [".github/workflows/", "CI workflow"],
  [".husky/", "git hook"],
  [".githooks/", "git hook"],
];

/** What an agent or editor does with this path, or null when it is not such a file. */
export function agentFileKind(path: string): string | null {
  if (EXACT[path]) return EXACT[path];
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (INSTRUCTION_NAMES.has(base)) return "agent instructions";
  for (const [prefix, kind] of PREFIXES) if (path.startsWith(prefix)) return kind;
  return null;
}

/** The changed paths an agent or editor executes or obeys, with what each one is. */
export function agentFilesIn(paths: string[]): { file: string; kind: string }[] {
  return paths.flatMap((file) => {
    const kind = agentFileKind(file);
    return kind ? [{ file, kind }] : [];
  });
}

/** The terminal colours the lines use; passed in so this module stays free of output state. */
interface Palette {
  yellow: string;
  dim: string;
  reset: string;
}

/** `verify-pull`'s section for these files: none when there are none, at most 20 named. */
export function pulledAgentFileLines(
  files: { file: string; kind: string }[],
  c: Palette,
): string[] {
  if (files.length === 0) return [];
  const lines = [
    `${c.yellow}⚠ ${files.length} file(s) an agent or editor runs or obeys:${c.reset}`,
  ];
  for (const { file, kind } of files.slice(0, 20))
    lines.push(`  ${c.yellow}•${c.reset} ${file}  ${c.dim}${kind}${c.reset}`);
  if (files.length > 20) lines.push(`  ${c.dim}… ${files.length - 20} more${c.reset}`);
  lines.push(
    `${c.dim}  → read them before opening an agent session or the folder in an editor: a hook, MCP server or task here runs on its own.${c.reset}\n`,
  );
  return lines;
}
