/**
 * `kit agent-config --user`: the PreToolUse gates (`gate-bash`, `gate-env`) in the user-level
 * `~/.claude/settings.json`, which Claude Code applies in every project on the machine. A clone,
 * a new worktree or a repo kit never set up is gated from the first tool call.
 *
 * It reuses the project installers in `agent-config.ts`, pointed at the home directory, so the
 * hook entries, the fail-closed `onFailure: "block"` and the refresh of a stale command are the
 * same. Two things differ, because the user file holds settings for every project:
 *   - an existing file that is not a JSON object, or whose `hooks` cannot take a PreToolUse entry,
 *     is refused instead of being replaced by a fresh one, so no key is dropped;
 *   - the file as it was is copied to `settings.json.bak` before kit writes it (as
 *     `kit memory install` does for the same file).
 * The home directory comes from `os.homedir()`: HOME on POSIX, USERPROFILE on Windows.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { installEnvWriteGate, installInstallGate, type HookInstallResult } from "./agent-config.js";
import { gateSettingsFile } from "./gate-settings.js";
import { userSettingsPath } from "./gate-liveness-user.js";
import { isReadOnlyMode } from "./read-only-mode.js";

export interface UserGatesResult {
  /** Absolute path of the user-level settings file. */
  file: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  detail?: string;
  /** Where the file as it was is kept, when kit copied it. */
  backup?: string;
  gates: { gate: "gate-bash" | "gate-env"; result: HookInstallResult }[];
}

/** Why the existing file cannot be merged into, or null when it can (or does not exist). */
function refusal(path: string): string | null {
  if (!existsSync(path)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return `${path} is not valid JSON (${why}); refusing to overwrite it, which would drop your other settings. Fix or move it, then re-run`;
  }
  const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(doc)) return `${path} is not a JSON object; refusing to overwrite it`;
  const hooks = (doc as { hooks?: unknown }).hooks;
  if (hooks !== undefined && !isObject(hooks)) return `${path}: "hooks" is not an object`;
  const pre = (hooks as { PreToolUse?: unknown } | undefined)?.PreToolUse;
  if (pre !== undefined && !Array.isArray(pre)) {
    return `${path}: "hooks.PreToolUse" is not an array`;
  }
  return null;
}

function textOf(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function overall(before: string | null, after: string | null, gates: UserGatesResult["gates"]) {
  const failed = gates.find((g) => g.result.action === "failed" || g.result.action === "skipped");
  if (failed)
    return { action: "failed" as const, detail: `${failed.gate}: ${failed.result.detail}` };
  if (before === null) return { action: "created" as const };
  return { action: before === after ? ("unchanged" as const) : ("updated" as const) };
}

/** Write `gate-bash` and `gate-env` into `<home>/.claude/settings.json`, merging into what is there. */
export async function installUserGates(home: string = homedir()): Promise<UserGatesResult> {
  const file = userSettingsPath(home);
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode", gates: [] };
  const refused = refusal(file);
  if (refused) return { file, action: "failed", detail: refused, gates: [] };
  // The installers pick settings.local.json when settings.json is tracked by git (a dotfiles repo
  // in the home directory). Claude Code reads no user-level settings.local.json, so stop there.
  if (resolve(home, await gateSettingsFile(home)) !== file) {
    const detail = `${file} is tracked by git, so the gates would go to settings.local.json, which Claude Code does not read at user level`;
    return { file, action: "failed", detail, gates: [] };
  }
  const before = textOf(file);
  let backup: string | undefined;
  if (before !== null) {
    backup = `${file}.bak`;
    copyFileSync(file, backup);
  }
  mkdirSync(dirname(file), { recursive: true });
  const gates: UserGatesResult["gates"] = [
    { gate: "gate-bash", result: await installInstallGate(home) },
    { gate: "gate-env", result: await installEnvWriteGate(home) },
  ];
  return { file, ...overall(before, textOf(file), gates), backup, gates };
}

/** Lines that say what `installUserGates` did, for the command to print. */
export function describeUserGates(r: UserGatesResult): string[] {
  const lines = [`${r.file}: ${r.action}${r.detail ? ` (${r.detail})` : ""}`];
  for (const { gate, result } of r.gates) {
    lines.push(`  ${gate}: ${result.action}${result.detail ? ` (${result.detail})` : ""}`);
  }
  if (r.backup) lines.push(`the file as it was: ${r.backup}`);
  if (r.action !== "failed" && r.action !== "skipped") {
    lines.push("Claude Code now runs these gates in every project on this machine.");
  }
  return lines;
}
