/**
 * An agent may not unwire its own gates. kit-research `verify-against-real-state-vs-kit` and
 * `humanmaxxing-vs-kit`: the `gate-bash` and `gate-env` entries live in `.claude/settings.json`,
 * `.claude/settings.local.json` or `~/.claude/settings.json`, and an agent's own Write or Edit
 * could remove or replace them; `gate-env` allowed it. `kit check` now notices a replaced gate
 * afterwards (`gate-identity.ts`); this refuses the edit when it is made.
 *
 * Rules, for a settings file that wires a kit gate now:
 *   - **Write / Edit / MultiEdit:** the resulting file is computed from the current one and the
 *     tool input. Refused when it no longer parses, or when any kit gate command in it now is
 *     missing from the result. Adding other hooks (another tool's installer) stays allowed.
 *   - **Shell:** a segment that names the settings file and starts with a command that changes
 *     files (`sed`, `mv`, `rm`, `tee`, …) or redirects into it is refused, because its effect
 *     cannot be computed here.
 * Not refused: `kit agent-config`, which a person or the agent runs as a process, and anything
 * outside the gated tools (a script written earlier, another process). That is what the
 * `enforcement evidence` row checks afterwards.
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { GATE_SUBCOMMANDS, commandIncludesSubcommand } from "./agent-config-hook-liveness.js";

const KIT_GATES = GATE_SUBCOMMANDS;

const MUTATING = new Set([
  "rm",
  "mv",
  "cp",
  "ln",
  "truncate",
  "shred",
  "dd",
  "tee",
  "sed",
  "perl",
  "install",
  "rsync",
  "del",
  "erase",
  "move",
  "copy",
  "ren",
  "remove-item",
  "set-content",
  "add-content",
  "out-file",
  "move-item",
  "copy-item",
  "rename-item",
  "clear-content",
]);

function settingsTargets(cwd: string, home: string): string[] {
  return [
    resolve(cwd, ".claude", "settings.json"),
    resolve(cwd, ".claude", "settings.local.json"),
    join(home, ".claude", "settings.json"),
  ];
}

function sameTarget(a: string, b: string): boolean {
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** The kit gate commands a settings text wires, or null when it does not parse as an object. */
export function kitGateCommands(text: string): string[] | null {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return null;
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return null;
  const hooks = (settings as { hooks?: Record<string, unknown> }).hooks;
  const pre = hooks && Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const out: string[] = [];
  for (const group of pre as { hooks?: { command?: unknown }[] }[]) {
    for (const h of Array.isArray(group?.hooks) ? group.hooks : []) {
      const cmd = h?.command;
      if (typeof cmd === "string" && KIT_GATES.some((s) => commandIncludesSubcommand(cmd, s))) {
        out.push(cmd);
      }
    }
  }
  return out;
}

interface EditInput {
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

/** The file after the tool call, or null when it cannot be computed from the input. */
export function resultingText(current: string, input: Record<string, unknown>): string | null {
  if (typeof input.content === "string") return input.content;
  const edits: EditInput[] = Array.isArray(input.edits)
    ? (input.edits as EditInput[])
    : typeof input.old_string === "string"
      ? [input as EditInput]
      : [];
  if (edits.length === 0) return null;
  let text = current;
  for (const e of edits) {
    if (typeof e.old_string !== "string" || typeof e.new_string !== "string") return null;
    if (!text.includes(e.old_string)) return null;
    text =
      e.replace_all === true
        ? text.split(e.old_string).join(e.new_string)
        : text.replace(e.old_string, () => e.new_string as string);
  }
  return text;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Why a file write is refused, or null when it leaves kit's gate entries in place. */
export function gateSettingsWriteRefusal(
  payload: unknown,
  cwd: string,
  home: string,
  read: (path: string) => string | null = readOrNull,
): string | null {
  const input = ((payload ?? {}) as { tool_input?: Record<string, unknown> }).tool_input ?? {};
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return null;
  const abs = resolve(cwd, filePath);
  const target = settingsTargets(cwd, home).find((t) => sameTarget(t, abs));
  if (!target) return null;
  const current = read(target);
  const wired = current === null ? [] : (kitGateCommands(current) ?? []);
  if (wired.length === 0) return null;
  const next = resultingText(current as string, input);
  if (next === null) {
    return `the edit to ${basename(target)} cannot be checked against kit's gate hooks it holds`;
  }
  const after = kitGateCommands(next);
  if (after === null) {
    return `the write would leave ${basename(target)} unparseable, which turns kit's gates off`;
  }
  if (wired.some((cmd) => !after.includes(cmd))) {
    return `the write would remove or change kit's gate hooks in ${basename(target)}`;
  }
  return null;
}

function commandWord(segment: string): string {
  for (const word of segment.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    const name = basename(word.replace(/^["']|["']$/g, ""))
      .toLowerCase()
      .replace(/\.exe$/, "");
    if (["sudo", "doas", "command", "builtin", "exec", "nohup", "env", "time"].includes(name))
      continue;
    return name;
  }
  return "";
}

const SETTINGS_NAME = /\.claude[\\/]settings(?:\.local)?\.json/i;

/** Why a shell command is refused, or null. Only when a settings file here wires a kit gate. */
export function gateSettingsCommandRefusal(
  command: string,
  cwd: string,
  home: string,
  read: (path: string) => string | null = readOrNull,
): string | null {
  if (!SETTINGS_NAME.test(command)) return null;
  const wired = settingsTargets(cwd, home).some((t) => {
    const text = read(t);
    return text !== null && (kitGateCommands(text) ?? []).length > 0;
  });
  if (!wired) return null;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    if (!SETTINGS_NAME.test(segment)) continue;
    const redirect = /\d?>{1,2}\|?\s*("[^"]*"|'[^']*'|\S+)/g;
    const into = [...segment.matchAll(redirect)].some((m) => SETTINGS_NAME.test(m[1] ?? ""));
    if (MUTATING.has(commandWord(segment)) || into) {
      return "the command changes a settings file that holds kit's gate hooks; run `kit agent-config` to change them";
    }
  }
  return null;
}
