/**
 * kit memory — install/remove lifecycle hooks for Claude Code and Codex.
 *
 * Idempotent and non-destructive: merges our hook entries into the existing
 * settings without touching the user's other hooks. Re-running adds nothing.
 * Honors KIT_CLAUDE_SETTINGS / KIT_CODEX_HOOKS for tests.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { kitWrapperPath } from "../kit-wrapper.js";

/**
 * Invocation of kit for use inside a lifecycle hook. Hook commands run in a
 * non-login `/bin/sh` whose PATH usually does NOT include the npm global bin
 * (`~/.npm-global/bin`, nvm/volta/pnpm shims, etc.). A bare `kit` there fails
 * with "command not found" and SILENTLY breaks memory capture — the worst
 * failure mode, because the store looks installed but records nothing.
 *
 * The wrapper itself is machine-local and contains absolute node/kit paths. Hook
 * config may be shared with the repo, so it refers to the wrapper through `$HOME`
 * instead of baking the installer user's home directory.
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
  if (existsSync(wrapper)) return '"$HOME/.kit/bin/kit"';
  const entry = process.argv[1];
  if (entry) return `${process.execPath} ${resolve(entry)}`;
  return "kit";
}

/** A kit memory hook is identified by this stable suffix, regardless of how
 *  kit was invoked — lets us dedupe + clean up old bare-`kit` entries. */
const hookSuffix = (sub: string): string => `memory hook ${sub}`;

interface MemoryHookDef {
  event: string;
  sub: string;
  timeout?: number;
  statusMessage?: string;
}

const CLAUDE_MEMORY_HOOKS: MemoryHookDef[] = [
  { event: "UserPromptSubmit", sub: "user-prompt-submit" },
  { event: "SessionEnd", sub: "session-end" },
  { event: "SessionStart", sub: "session-start" },
];

// Codex's SessionEnd must identify its harness so the detached worker indexes
// the just-ended Codex rollout immediately instead of taking the Claude-only
// fast path. Codex caps SessionEnd hooks at 3 seconds; the command only launches
// a detached worker, but use the cap to tolerate slow process startup.
const CODEX_MEMORY_HOOKS: MemoryHookDef[] = [
  {
    event: "SessionEnd",
    sub: "session-end-codex",
    timeout: 3,
    statusMessage: "kit memory: saving session",
  },
  {
    event: "SessionStart",
    sub: "session-start",
    statusMessage: "kit memory: loading session context",
  },
];

// Codex renders every UserPromptSubmit stdout payload in the conversation UI.
// The reminder is already a durable AGENTS.md rule, so keep its enforcement
// without repeating noisy hook context after every user message. Kept here for
// upgrade cleanup: re-running `kit memory install` removes the old wiring.
const CODEX_RETIRED_MEMORY_HOOKS: MemoryHookDef[] = [
  { event: "UserPromptSubmit", sub: "user-prompt-submit" },
];

export function getClaudeSettingsPath(): string {
  return process.env.KIT_CLAUDE_SETTINGS ?? join(homedir(), ".claude", "settings.json");
}

export function getCodexHooksPath(): string {
  if (process.env.KIT_CODEX_HOOKS) return process.env.KIT_CODEX_HOOKS;
  const codexHome = process.env.KIT_CODEX_DIR ?? join(homedir(), ".codex");
  return join(codexHome, "hooks.json");
}

/**
 * A durable marker that memory hooks were installed on this machine. It survives
 * even if the hooks are later stripped from settings.json — that's the whole point:
 * it lets a liveness check tell "never installed" (silent = fine) apart from
 * "was installed, now GONE" (the loop silently degraded to capture-nothing).
 */
export function memoryInstallMarkerPath(): string {
  return process.env.KIT_MEMORY_HOOK_MARKER ?? join(homedir(), ".kit", ".memory-hooks-installed");
}

export function codexMemoryInstallMarkerPath(): string {
  return (
    process.env.KIT_CODEX_MEMORY_HOOK_MARKER ??
    join(homedir(), ".kit", ".memory-hooks-codex-installed")
  );
}

export interface HookLiveness {
  /** Memory hooks were installed here at least once (marker present). */
  everInstalled: boolean;
  /** Wired events currently present in settings.json. */
  present: string[];
  /** Events that SHOULD be wired (were installed) but are missing now. */
  missing: string[];
}

/**
 * R5: is the capture loop still wired? If memory was ever installed (marker) but
 * a hook has since vanished from settings.json, the loop silently stops recording
 * — the worst failure mode. This makes that visible. Deterministic, read-only.
 */
export function memoryHooksLiveness(
  settingsPath: string = getClaudeSettingsPath(),
  markerPath: string = memoryInstallMarkerPath(),
): HookLiveness {
  return hooksLivenessAtPath(settingsPath, markerPath, CLAUDE_MEMORY_HOOKS);
}

export function codexMemoryHooksLiveness(
  hooksPath: string = getCodexHooksPath(),
  markerPath: string = codexMemoryInstallMarkerPath(),
): HookLiveness {
  return hooksLivenessAtPath(hooksPath, markerPath, CODEX_MEMORY_HOOKS);
}

/** Aggregate only harnesses installed at least once on this machine. */
export function allMemoryHooksLiveness(): HookLiveness {
  const sources = [
    { name: "Claude Code", live: memoryHooksLiveness() },
    { name: "Codex", live: codexMemoryHooksLiveness() },
  ].filter(({ live }) => live.everInstalled);
  return {
    everInstalled: sources.length > 0,
    present: sources.flatMap(({ name, live }) => live.present.map((event) => `${name}:${event}`)),
    missing: sources.flatMap(({ name, live }) => live.missing.map((event) => `${name}:${event}`)),
  };
}

function hooksLivenessAtPath(
  settingsPath: string,
  markerPath: string,
  definitions: MemoryHookDef[],
): HookLiveness {
  const everInstalled = existsSync(markerPath);
  let hooks: Record<string, HookGroup[]>;
  try {
    hooks = (readSettings(settingsPath).hooks ?? {}) as Record<string, HookGroup[]>;
  } catch {
    hooks = {}; // unparseable settings → treat all as missing (surfaced as a problem)
  }
  const present: string[] = [];
  const missing: string[] = [];
  for (const { event, sub } of definitions) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (groupsHaveHook(groups, sub)) present.push(event);
    else missing.push(event);
  }
  return { everInstalled, present, missing };
}

interface HookCmd {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
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
  if (!existsSync(path)) return {}; // first-time install — a fresh settings object is correct
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Settings;
  } catch (e) {
    // An EXISTING but unparseable settings.json must NOT be treated as empty — that
    // would let writeSettings overwrite the whole file (permissions, env, other hooks,
    // statusLine) with only kit's block. Refuse loudly instead of silently clobbering.
    throw new Error(
      `${path} is not valid JSON — refusing to overwrite it (that would drop your other hook/settings entries). Fix or move the file aside, then re-run. Parse error: ${(e as Error).message}`,
      { cause: e },
    );
  }
}

function writeSettings(path: string, s: Settings): void {
  mkdirSync(dirname(path), { recursive: true });
  // Back up an existing file before the first overwrite (mirrors identity.json.*.bak),
  // so even an unexpected clobber is recoverable.
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
    } catch {
      /* best-effort backup — the merge below is still non-destructive */
    }
  }
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
  updated: string[];
  resolved: boolean;
} {
  return installHooksAtPath(path, memoryInstallMarkerPath(), CLAUDE_MEMORY_HOOKS);
}

export function installCodexMemoryHooks(path: string = getCodexHooksPath()): {
  added: string[];
  alreadyPresent: string[];
  updated: string[];
  resolved: boolean;
} {
  return installHooksAtPath(
    path,
    codexMemoryInstallMarkerPath(),
    CODEX_MEMORY_HOOKS,
    CODEX_RETIRED_MEMORY_HOOKS,
  );
}

function installHooksAtPath(
  path: string,
  markerPath: string,
  definitions: MemoryHookDef[],
  retiredDefinitions: MemoryHookDef[] = [],
): { added: string[]; alreadyPresent: string[]; updated: string[]; resolved: boolean } {
  const s = readSettings(path);
  const hooks = (s.hooks ??= {});
  const prefix = kitHookInvocation();
  const resolved = prefix !== "kit";
  const added: string[] = [];
  const alreadyPresent: string[] = [];
  const updated: string[] = [];
  const retired = removeHookDefinitions(s, retiredDefinitions);
  for (const { event, sub, timeout, statusMessage } of definitions) {
    const groups = (hooks[event] ??= []);
    const desired: HookCmd = { type: "command", command: `${prefix} ${hookSuffix(sub)}` };
    if (timeout !== undefined) desired.timeout = timeout;
    if (statusMessage !== undefined) desired.statusMessage = statusMessage;
    const upgrade = refreshHookDefinition(groups, sub, desired);
    if (upgrade === "updated") {
      updated.push(event);
      continue;
    }
    if (upgrade === "current") {
      alreadyPresent.push(event);
      continue;
    }
    groups.push({ hooks: [desired] });
    added.push(event);
  }
  if (added.length || updated.length || retired.length) writeSettings(path, s);
  // Durable "installed here" marker for the liveness check (idempotent). After
  // this call the hooks ARE present (added or alreadyPresent), so stamp it.
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    if (!existsSync(markerPath)) writeFileSync(markerPath, new Date().toISOString() + "\n");
  } catch {
    /* best-effort: a missing marker only weakens the liveness check, never breaks install */
  }
  return { added, alreadyPresent, updated, resolved };
}

/** Remove only kit commands from matching groups, preserving unrelated hooks. */
function refreshHookDefinition(
  groups: HookGroup[],
  sub: string,
  desired: HookCmd,
): "missing" | "current" | "updated" {
  const suffix = hookSuffix(sub);
  let found = false;
  let changed = false;
  for (const group of groups) {
    if (!group.hooks) continue;
    for (const hook of group.hooks) {
      if (!hook.command.endsWith(suffix)) continue;
      found = true;
      if (
        hook.command !== desired.command ||
        hook.timeout !== desired.timeout ||
        hook.statusMessage !== desired.statusMessage
      ) {
        hook.command = desired.command;
        if (desired.timeout === undefined) delete hook.timeout;
        else hook.timeout = desired.timeout;
        if (desired.statusMessage === undefined) delete hook.statusMessage;
        else hook.statusMessage = desired.statusMessage;
        changed = true;
      }
    }
  }
  if (changed) return "updated";
  return found ? "current" : "missing";
}

function removeHookDefinitions(s: Settings, definitions: MemoryHookDef[]): string[] {
  const removed: string[] = [];
  if (!s.hooks) return removed;
  for (const { event, sub } of definitions) {
    const groups = s.hooks[event];
    if (!Array.isArray(groups)) continue;
    const suffix = hookSuffix(sub);
    let didRemove = false;
    const filtered: HookGroup[] = [];
    for (const group of groups) {
      const kept = group.hooks?.filter((hook) => {
        const remove = hook.command.endsWith(suffix);
        didRemove ||= remove;
        return !remove;
      });
      if (kept?.length) filtered.push({ ...group, hooks: kept });
    }
    const wasEmpty = groups.length === 0;
    if (didRemove || wasEmpty) {
      if (filtered.length > 0) {
        s.hooks[event] = filtered;
      } else {
        delete s.hooks[event];
      }
      removed.push(event);
    }
  }
  return removed;
}

// ── Claude Code status line (the persistent info bar) ────────────────────────
//
// Wiring `kit statusline` as Claude Code's `statusLine` is what makes the setup
// score + the open-PAL ("blocked-on-you") count VISIBLE in the terminal — without
// it, PAL only reaches the agent via the hook, never the human. We never clobber
// a user's existing custom statusLine; we only set it when absent (or refresh our
// own), and report a "foreign" status so the caller can tell the user.

const STATUSLINE_SUFFIX = "statusline";

/** True if `cmd` looks like OUR statusLine wiring (so we can refresh/remove it). */
function isKitStatusline(cmd: string | undefined): boolean {
  return !!cmd && cmd.trimEnd().endsWith(STATUSLINE_SUFFIX) && cmd.includes("kit");
}

export type StatuslineInstall = "added" | "updated" | "already" | "foreign";

export function installStatusline(path: string = getClaudeSettingsPath()): {
  status: StatuslineInstall;
  resolved: boolean;
} {
  const s = readSettings(path);
  const prefix = kitHookInvocation();
  const resolved = prefix !== "kit";
  const desired = `${prefix} ${STATUSLINE_SUFFIX}`;
  const existing = s.statusLine as { command?: string } | undefined;
  if (existing && typeof existing === "object") {
    // Already ours → refresh stale hook paths; someone else's → never clobber it.
    if (!isKitStatusline(existing.command)) return { status: "foreign", resolved };
    if (existing.command === desired) return { status: "already", resolved };
    existing.command = desired;
    writeSettings(path, s);
    return { status: "updated", resolved };
  }
  s.statusLine = { type: "command", command: desired };
  writeSettings(path, s);
  return { status: "added", resolved };
}

export function uninstallStatusline(path: string = getClaudeSettingsPath()): { removed: boolean } {
  const s = readSettings(path);
  const existing = s.statusLine as { command?: string } | undefined;
  if (existing && isKitStatusline(existing.command)) {
    delete s.statusLine;
    writeSettings(path, s);
    return { removed: true };
  }
  return { removed: false }; // absent, or a user's own statusLine → leave it
}

export function uninstallMemoryHooks(path: string = getClaudeSettingsPath()): {
  removed: string[];
} {
  return uninstallHooksAtPath(path, memoryInstallMarkerPath(), CLAUDE_MEMORY_HOOKS);
}

export function uninstallCodexMemoryHooks(path: string = getCodexHooksPath()): {
  removed: string[];
} {
  return uninstallHooksAtPath(path, codexMemoryInstallMarkerPath(), [
    ...CODEX_MEMORY_HOOKS,
    ...CODEX_RETIRED_MEMORY_HOOKS,
  ]);
}

function uninstallHooksAtPath(
  path: string,
  markerPath: string,
  definitions: MemoryHookDef[],
): { removed: string[] } {
  const s = readSettings(path);
  const removed = removeHookDefinitions(s, definitions);
  if (removed.length) writeSettings(path, s);
  // Intentional uninstall clears the marker, so the liveness check won't then
  // report the (deliberate) absence as silent tampering.
  try {
    if (existsSync(markerPath)) unlinkSync(markerPath);
  } catch {
    /* best-effort */
  }
  return { removed };
}
