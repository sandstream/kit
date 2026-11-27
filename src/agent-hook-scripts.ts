/**
 * The script files a Claude `settings.json` hook runs.
 *
 * The 2026 npm worms (SAP CAP, TanStack, AntV, ChainDrop) persisted with a `SessionStart` hook in
 * `.claude/settings.json` whose command was `node .claude/setup.mjs`: the command string itself
 * has no malware shape, the payload is in the file. `auditSettingsCommands` read only the string,
 * so the shape passed (kit-research `supply-chain-2026-fundamentals-vs-kit`).
 *
 * This reads each project-relative script a hook command names and runs the same malware
 * patterns on its content. A hook that runs a project file is also reported as a warning even
 * when the file looks clean: the harness executes it on its own, outside every tool-call gate,
 * from a file any dependency's install script or an agent's own edit can write. That used to be
 * reported for `SessionStart` only; the same script on `Stop`, `PostToolUse`, `UserPromptSubmit`,
 * `PreCompact` or `PreToolUse` gave "no issues" (kit-research `agent-platform-2027-vs-kit`), and
 * a `PreToolUse` hook runs more often than a `SessionStart` one. One row per event and file.
 */
import { isAbsolute, resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { auditHookBody } from "./agent-audit.js";
import { readInstructionFile } from "./instruction-scan.js";

const SCRIPT = /\.(m?js|cjs|ts|mts|sh|bash|zsh|py|rb|ps1)$/i;

/** The commands of one hook group: nested `hooks[]` (Claude Code, Codex, Gemini CLI) or a flat entry (Cursor). */
function groupCommands(group: unknown): string[] {
  const nested = (group as { hooks?: unknown } | null)?.hooks;
  const entries = Array.isArray(nested) ? nested : [group];
  return entries
    .map((h) => (h as { command?: unknown } | null)?.command)
    .filter((cmd): cmd is string => typeof cmd === "string" && cmd.length > 0);
}

/**
 * `[event, command]` for every hook command in a settings JSON text. Claude Code, Codex and Gemini
 * CLI nest commands under `hooks.<Event>[].hooks[]`; Cursor's `.cursor/hooks.json` lists them flat
 * under `hooks.<event>[]`. Both shapes are read. Factory Droid's standalone `hooks.json` has no
 * `hooks` wrapper: it is keyed directly by event name (docs.factory.com/reference/hooks-reference.md,
 * "Structure"), so top-level PascalCase keys holding a list are read as events too.
 */
export function hookCommands(json: string): Array<[string, string]> {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const out: Array<[string, string]> = [];
  const read = (map: Record<string, unknown>, isEvent: (key: string) => boolean) => {
    for (const [event, groups] of Object.entries(map)) {
      if (!isEvent(event) || !Array.isArray(groups)) continue;
      for (const g of groups) for (const cmd of groupCommands(g)) out.push([event, cmd]);
    }
  };
  const hooks = (obj as { hooks?: unknown }).hooks;
  if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
    read(hooks as Record<string, unknown>, () => true);
  }
  read(obj as Record<string, unknown>, (key) => /^[A-Z][A-Za-z]+$/.test(key));
  return out;
}

/** Project-relative script paths a command names (`$CLAUDE_PROJECT_DIR/` counts as relative). */
export function scriptPaths(command: string): string[] {
  return command
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, "").replace(/^\$\{?CLAUDE_PROJECT_DIR\}?[\\/]/, ""))
    .filter((w) => w && !w.startsWith("-") && !isAbsolute(w) && SCRIPT.test(w));
}

/** Rows for the scripts the hooks in `json` (found at `shown`) run, resolved under `root`. */
export function hookScriptRows(json: string, root: string, shown: string): SecurityCheckResult[] {
  const rows: SecurityCheckResult[] = [];
  const seen = new Set<string>();
  for (const [event, command] of hookCommands(json)) {
    for (const rel of scriptPaths(command)) {
      // One descriptor for the size check and the read, so the file cannot be swapped between them.
      const body = readInstructionFile(resolve(root, rel));
      if (body === null) continue;
      const why = auditHookBody(body);
      if (why.length > 0) {
        rows.push({
          category: "exposure",
          name: `malware-shaped hook script ${rel} (${shown} hooks.${event})`,
          status: "fail",
          severity: "high",
          detail: `${rel}, run by a ${event} hook in ${shown}, ${why.join("; ")}`,
          suggestion: `remove the hook from ${shown} and inspect ${rel}; it runs automatically`,
        });
      } else if (!seen.has(`${event}\n${rel}`)) {
        seen.add(`${event}\n${rel}`);
        const when = event === "SessionStart" ? "on every agent start" : `on every ${event} event`;
        rows.push({
          category: "exposure",
          name: `${event} hook runs a project file (${rel})`,
          status: "warn",
          severity: "low",
          detail: `${shown} runs ${rel} ${when}; no known malware shape in it, but any install script or agent edit can rewrite it`,
          suggestion: `confirm ${rel} is yours and reviewed, or run a command instead of a repo file`,
        });
      }
    }
  }
  return rows;
}
