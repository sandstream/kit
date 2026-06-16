/**
 * kit memory — install/remove the two Claude Code hooks in ~/.claude/settings.json.
 *
 * Idempotent and non-destructive: merges our hook entries into the existing
 * settings without touching the user's other hooks. Re-running adds nothing.
 * Honors KIT_CLAUDE_SETTINGS for tests.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const MEMORY_HOOKS: { event: string; command: string }[] = [
  { event: "UserPromptSubmit", command: "kit memory hook user-prompt-submit" },
  { event: "SessionEnd", command: "kit memory hook session-end" },
  { event: "SessionStart", command: "kit memory hook session-start" },
];

export function getClaudeSettingsPath(): string {
  return process.env.KIT_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

interface HookCmd {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCmd[];
}
interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Settings;
  } catch {
    return {}; // corrupt/unreadable → start fresh rather than crash
  }
}

function writeSettings(path: string, s: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
}

function groupsHaveCommand(groups: HookGroup[], command: string): boolean {
  return groups.some((g) => g.hooks?.some((h) => h.command === command));
}

export function installMemoryHooks(
  path: string = getClaudeSettingsPath(),
): { added: string[]; alreadyPresent: string[] } {
  const s = readSettings(path);
  const hooks = (s.hooks ??= {});
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const { event, command } of MEMORY_HOOKS) {
    const groups = (hooks[event] ??= []);
    if (groupsHaveCommand(groups, command)) {
      alreadyPresent.push(event);
      continue;
    }
    groups.push({ hooks: [{ type: "command", command }] });
    added.push(event);
  }
  if (added.length) writeSettings(path, s);
  return { added, alreadyPresent };
}

export function uninstallMemoryHooks(
  path: string = getClaudeSettingsPath(),
): { removed: string[] } {
  const s = readSettings(path);
  if (!s.hooks) return { removed: [] };
  const removed: string[] = [];
  for (const { event, command } of MEMORY_HOOKS) {
    const groups = s.hooks[event];
    if (!Array.isArray(groups)) continue;
    const filtered = groups.filter((g) => !g.hooks?.some((h) => h.command === command));
    if (filtered.length !== groups.length) {
      s.hooks[event] = filtered;
      removed.push(event);
    }
  }
  if (removed.length) writeSettings(path, s);
  return { removed };
}
