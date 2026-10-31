/**
 * Wire `kit hooks context` into Claude Code's `SessionStart` hooks (#671).
 *
 * The git-hook floor is real once installed, but installing it was a line of prose in the managed
 * block, and an agent can skip prose. A `SessionStart` hook runs whether or not the agent reads the
 * block, and what it prints on a zero exit lands in the agent's context. So a session in a checkout
 * whose declared hooks do not run starts by being told so, with the command that fixes it.
 *
 * Idempotent and keyed on the command, like the PreToolUse gates: an existing entry is refreshed
 * to the current invocation, other hooks are preserved, and read-only mode writes nothing.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { kitSubcommandInvocation, type HookInstallResult } from "./agent-config.js";

export const SESSION_START_SUBCOMMAND = "hooks context";

interface HookCmd {
  type?: string;
  command?: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCmd[];
}
type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

/** Add or refresh the entry in `settings`; returns what changed. Pure, for tests. */
export function upsertSessionStartCheck(
  settings: Settings,
  command: string,
): "added" | "updated" | "unchanged" {
  const groups = ((settings.hooks ??= {}).SessionStart ??= []);
  let found = false;
  let updated = false;
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if (typeof hook.command !== "string" || !hook.command.includes(SESSION_START_SUBCOMMAND)) {
        continue;
      }
      found = true;
      if (hook.command !== command) {
        hook.command = command;
        updated = true;
      }
    }
  }
  if (found) return updated ? "updated" : "unchanged";
  groups.push({ hooks: [{ type: "command", command }] });
  return "added";
}

/** Install the session-start floor check into `<cwd>/.claude/settings.json`. */
export async function installSessionStartCheck(
  cwd: string = process.cwd(),
  command: string = kitSubcommandInvocation(SESSION_START_SUBCOMMAND),
): Promise<HookInstallResult> {
  const file = ".claude/settings.json";
  const path = resolve(cwd, file);
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { file, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".claude")) && !existsSync(resolve(cwd, "CLAUDE.md"))) {
    return { file, action: "skipped", detail: "no Claude Code project detected" };
  }
  let settings: Settings = {};
  let existed = false;
  try {
    settings = JSON.parse(await readFile(path, "utf-8")) as Settings;
    existed = true;
  } catch (err) {
    if (existsSync(path)) {
      // Never overwrite a settings file we could not parse: that would drop the user's hooks.
      return { file, action: "failed", detail: `could not parse ${file}: ${String(err)}` };
    }
  }
  const change = upsertSessionStartCheck(settings, command);
  if (change === "unchanged") return { file, action: "unchanged", detail: "already wired" };
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch (err) {
    return { file, action: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  return { file, action: change === "updated" ? "updated" : existed ? "updated" : "created" };
}
