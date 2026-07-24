/**
 * kit memory — install/remove the two Claude Code hooks in ~/.claude/settings.json.
 *
 * Idempotent and non-destructive: merges our hook entries into the existing
 * settings without touching the user's other hooks. Re-running adds nothing.
 * Honors KIT_CLAUDE_SETTINGS for tests.
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

/**
 * A durable marker that memory hooks were installed on this machine. It survives
 * even if the hooks are later stripped from settings.json — that's the whole point:
 * it lets a liveness check tell "never installed" (silent = fine) apart from
 * "was installed, now GONE" (the loop silently degraded to capture-nothing).
 */
export function memoryInstallMarkerPath(): string {
  return process.env.KIT_MEMORY_HOOK_MARKER ?? join(homedir(), ".kit", ".memory-hooks-installed");
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
  const everInstalled = existsSync(markerPath);
  let hooks: Record<string, HookGroup[]>;
  try {
    hooks = (readSettings(settingsPath).hooks ?? {}) as Record<string, HookGroup[]>;
  } catch {
    hooks = {}; // unparseable settings → treat all as missing (surfaced as a problem)
  }
  const present: string[] = [];
  const missing: string[] = [];
  for (const { event, sub } of MEMORY_HOOKS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    if (groupsHaveHook(groups, sub)) present.push(event);
    else missing.push(event);
  }
  return { everInstalled, present, missing };
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
  if (!existsSync(path)) return {}; // first-time install — a fresh settings object is correct
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Settings;
  } catch (e) {
    // An EXISTING but unparseable settings.json must NOT be treated as empty — that
    // would let writeSettings overwrite the whole file (permissions, env, other hooks,
    // statusLine) with only kit's block. Refuse loudly instead of silently clobbering.
    throw new Error(
      `${path} is not valid JSON — refusing to overwrite it (that would drop your other Claude Code settings). Fix or move the file aside, then re-run. Parse error: ${(e as Error).message}`,
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
  // Durable "installed here" marker for the liveness check (idempotent). After
  // this call the hooks ARE present (added or alreadyPresent), so stamp it.
  try {
    const marker = memoryInstallMarkerPath();
    mkdirSync(dirname(marker), { recursive: true });
    if (!existsSync(marker)) writeFileSync(marker, new Date().toISOString() + "\n");
  } catch {
    /* best-effort: a missing marker only weakens the liveness check, never breaks install */
  }
  return { added, alreadyPresent, resolved };
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

export type StatuslineInstall = "added" | "already" | "foreign";

export function installStatusline(path: string = getClaudeSettingsPath()): {
  status: StatuslineInstall;
  resolved: boolean;
} {
  const s = readSettings(path);
  const prefix = kitHookInvocation();
  const resolved = prefix !== "kit";
  const existing = s.statusLine as { command?: string } | undefined;
  if (existing && typeof existing === "object") {
    // Already ours → idempotent no-op; someone else's → never clobber it.
    return { status: isKitStatusline(existing.command) ? "already" : "foreign", resolved };
  }
  s.statusLine = { type: "command", command: `${prefix} ${STATUSLINE_SUFFIX}` };
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
  // Intentional uninstall clears the marker, so the liveness check won't then
  // report the (deliberate) absence as silent tampering.
  try {
    const marker = memoryInstallMarkerPath();
    if (existsSync(marker)) unlinkSync(marker);
  } catch {
    /* best-effort */
  }
  return { removed };
}
