/**
 * kit memory — install/remove the two Claude Code hooks in ~/.claude/settings.json.
 *
 * Idempotent and non-destructive: merges our hook entries into the existing
 * settings without touching the user's other hooks. Re-running adds nothing.
 * Honors KIT_CLAUDE_SETTINGS for tests.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { kitWrapperPath } from "../kit-wrapper.js";

/**
 * Absolute invocation of kit for use inside a Claude Code hook. Hooks run in a
 * non-login `/bin/sh` whose PATH usually does NOT include the npm global bin
 * (`~/.npm-global/bin`, nvm/volta/pnpm shims, etc.). A bare `kit` there fails
 * with "command not found" and SILENTLY breaks memory capture — the worst
 * failure mode, because the store looks installed but records nothing.
 *
 * Order of preference:
 *   1. The self-healing wrapper at ~/.kit/bin/kit (created by `memInstall`
 *      before this runs). It restores the tool PATH then exec's the real kit,
 *      so anything kit shells out to (git, etc.) also resolves.
 *   2. An absolute `<node> <cli.js>` resolved from the running process.
 *   3. A bare `kit` — last resort, relies on PATH (warns at the call site).
 */
function kitHookInvocation(): string {
  const wrapper = kitWrapperPath();
  if (existsSync(wrapper)) return wrapper;
  const entry = process.argv[1];
  if (entry) return `${process.execPath} ${resolve(entry)}`;
  return "kit";
}

/** A kit memory hook is identified by this stable suffix, regardless of how
 *  kit was invoked — lets us dedupe + clean up old bare-`kit` entries. */
const hookSuffix = (sub: string): string => `memory hook ${sub}`;

const MEMORY_HOOKS: { event: string; sub: string }[] = [
  { event: "UserPromptSubmit", sub: "user-prompt-submit" },
  { event: "SessionEnd", sub: "session-end" },
  { event: "SessionStart", sub: "session-start" },
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

/** True if any hook command in these groups is a kit memory hook for `sub`
 *  (matches by suffix, so a bare-`kit` or absolute-path entry both count). */
function groupsHaveHook(groups: HookGroup[], sub: string): boolean {
  const suffix = hookSuffix(sub);
  return groups.some((g) => g.hooks?.some((h) => h.command.endsWith(suffix)));
}

export function installMemoryHooks(path: string = getClaudeSettingsPath()): {
  added: string[];
  alreadyPresent: string[];
  resolved: boolean;
} {
  const s = readSettings(path);
  const hooks = (s.hooks ??= {});
  const prefix = kitHookInvocation();
  const resolved = prefix !== "kit";
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  for (const { event, sub } of MEMORY_HOOKS) {
    const groups = (hooks[event] ??= []);
    if (groupsHaveHook(groups, sub)) {
      alreadyPresent.push(event);
      continue;
    }
    groups.push({ hooks: [{ type: "command", command: `${prefix} ${hookSuffix(sub)}` }] });
    added.push(event);
  }
  if (added.length) writeSettings(path, s);
  return { added, alreadyPresent, resolved };
}

export function uninstallMemoryHooks(path: string = getClaudeSettingsPath()): {
  removed: string[];
} {
  const s = readSettings(path);
  if (!s.hooks) return { removed: [] };
  const removed: string[] = [];
  for (const { event, sub } of MEMORY_HOOKS) {
    const groups = s.hooks[event];
    if (!Array.isArray(groups)) continue;
    const suffix = hookSuffix(sub);
    const filtered = groups.filter((g) => !g.hooks?.some((h) => h.command.endsWith(suffix)));
    if (filtered.length !== groups.length) {
      s.hooks[event] = filtered;
      removed.push(event);
    }
  }
  if (removed.length) writeSettings(path, s);
  return { removed };
}
