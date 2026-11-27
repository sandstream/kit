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
 *     missing from the result.
 *   - **A new hook:** where any of the three settings files wires a kit gate, a write that adds a
 *     hook command the file does not hold now is refused, in any of the three, on any event. The
 *     harness runs a hook command itself, so no gate sees it: an agent that may add one can run
 *     anything outside the gates (kit-research `agent-platform-2027-vs-kit`; adding other hooks
 *     used to stay allowed). A person adds the hook, or an installer run as a process does.
 *   - **Shell:** a segment that names the settings file and starts with a command that changes
 *     files (`sed`, `mv`, `rm`, `tee`, …) or redirects into it is refused, because its effect
 *     cannot be computed here.
 * Permission rules (`gate-self-edit-rules.ts`, kit-research `prismor-always-allowed-rules-vs-kit`):
 * a write that removes one of kit's deny rules, or adds an allow that matches one, is refused the
 * same way, and so is a write that adds an allow rule to a Codex `.codex/rules/*.rules` file.
 * Not refused: `kit agent-config`, which a person or the agent runs as a process, and anything
 * outside the gated tools (a script written earlier, another process). That is what the
 * `enforcement evidence` row checks afterwards.
 */
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { GATE_SUBCOMMANDS, commandIncludesSubcommand } from "./agent-config-hook-liveness.js";
import {
  codexRulesWriteRefusal,
  denyRuleWriteRefusal,
  isCodexRulesPath,
} from "./gate-self-edit-rules.js";
import { heldKitDenyRules, permissionListsOf } from "./kit-deny-rules.js";

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

/** `event: command` for every hook entry of a settings text; empty when it does not parse. */
function hookEntries(text: string): string[] {
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return [];
  }
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: string[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      const entries = (group as { hooks?: unknown } | null)?.hooks;
      for (const h of Array.isArray(entries) ? entries : []) {
        const cmd = (h as { command?: unknown } | null)?.command;
        out.push(`${event}: ${typeof cmd === "string" ? cmd : JSON.stringify(h)}`);
      }
    }
  }
  return out;
}

/** Why the write is refused for the kit gates this file wires now, or null. */
function removalRefusal(wired: string[], next: string | null, name: string): string | null {
  if (wired.length === 0) return null;
  if (next === null)
    return `the edit to ${name} cannot be checked against kit's gate hooks it holds`;
  const after = kitGateCommands(next);
  if (after === null)
    return `the write would leave ${name} unparseable, which turns kit's gates off`;
  if (wired.some((cmd) => !after.includes(cmd))) {
    return `the write would remove or change kit's gate hooks in ${name}`;
  }
  return null;
}

/**
 * Why a file write is refused, or null: it removes a kit gate or a kit deny rule, adds a hook next
 * to a gate, adds an allow that matches a kit deny rule, or adds an allow rule to a Codex rules file.
 */
export function gateSettingsWriteRefusal(
  payload: unknown,
  cwd: string,
  home: string,
  read: (path: string) => string | null = readOrNull,
  codexHome: string | undefined = process.env.CODEX_HOME,
): string | null {
  const input = ((payload ?? {}) as { tool_input?: Record<string, unknown> }).tool_input ?? {};
  const filePath = typeof input.file_path === "string" ? input.file_path : "";
  if (!filePath) return null;
  const abs = resolve(cwd, filePath);
  if (isCodexRulesPath(abs, codexHome)) {
    const rules = read(abs);
    return codexRulesWriteRefusal(rules, resultingText(rules ?? "", input), basename(abs));
  }
  const targets = settingsTargets(cwd, home);
  const target = targets.find((t) => sameTarget(t, abs));
  if (!target) return null;
  const current = read(target);
  const wired = current === null ? [] : (kitGateCommands(current) ?? []);
  const next = resultingText(current ?? "", input);
  const removal =
    removalRefusal(wired, next, basename(target)) ??
    denyRuleWriteRefusal(current, next, basename(target), home);
  if (removal) return removal;
  const gated = wired.length > 0 || targets.some((t) => wiresGate(read(t)));
  if (!gated || next === null) return null;
  return addedHookRefusal(current ?? "", next, basename(target));
}

function wiresGate(text: string | null): boolean {
  return text !== null && (kitGateCommands(text) ?? []).length > 0;
}

/** Why the write is refused for a hook entry the file does not hold now, or null. */
function addedHookRefusal(current: string, next: string, name: string): string | null {
  const before = new Set(hookEntries(current));
  const added = hookEntries(next).find((entry) => !before.has(entry));
  if (!added) return null;
  const shown = added.length > 120 ? `${added.slice(0, 117)}...` : added;
  return `the write would add a hook to ${name} (${shown}); a hook runs outside kit's gates, so a person adds it, not the agent`;
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

/**
 * A Codex rules file named in a shell command: `.codex/rules/...`, or `rules/<name>.rules` (as in
 * `$CODEX_HOME/rules/default.rules`). A file reached through `cd` alone is not seen.
 */
const CODEX_RULES_NAME = /\.codex[\\/]rules\b|(?:^|[\s"'=\\/])rules[\\/][^\s"'\\/;|&<>]*\.rules\b/i;

/** Whether a segment of a shell command changes a file whose name matches `name`. */
function segmentWritesInto(command: string, name: RegExp): boolean {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    if (!name.test(segment)) continue;
    const redirect = /\d?>{1,2}\|?\s*("[^"]*"|'[^']*'|\S+)/g;
    const into = [...segment.matchAll(redirect)].some((m) => name.test(m[1] ?? ""));
    if (MUTATING.has(commandWord(segment)) || into) return true;
  }
  return false;
}

/** A settings text that wires a kit gate or holds a kit deny rule. */
function guarded(text: string | null): boolean {
  if (text === null) return false;
  if ((kitGateCommands(text) ?? []).length > 0) return true;
  return heldKitDenyRules(permissionListsOf(text)?.deny ?? []).length > 0;
}

/**
 * Why a shell command is refused, or null. A write to a settings file is refused where one of them
 * wires a kit gate or holds a kit deny rule; a write to a Codex rules file always is, because its
 * effect cannot be computed and an allow rule there runs commands outside Codex's sandbox.
 */
export function gateSettingsCommandRefusal(
  command: string,
  cwd: string,
  home: string,
  read: (path: string) => string | null = readOrNull,
): string | null {
  if (CODEX_RULES_NAME.test(command) && segmentWritesInto(command, CODEX_RULES_NAME)) {
    return "the command changes a Codex rules file, where an allow rule runs commands without a prompt; a person edits it, not the agent";
  }
  if (!SETTINGS_NAME.test(command)) return null;
  if (!settingsTargets(cwd, home).some((t) => guarded(read(t)))) return null;
  if (segmentWritesInto(command, SETTINGS_NAME)) {
    return "the command changes a settings file that holds kit's gate hooks or deny rules; run `kit agent-config` to change them";
  }
  return null;
}
