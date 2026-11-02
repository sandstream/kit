/**
 * Which settings file holds the PreToolUse gates. A gate command holds a path that only exists on
 * this machine ("$HOME/.kit/bin/kit"), so it must not go into a file that is committed: on another
 * clone or in CI the hook cannot start. Claude Code merges `.claude/settings.json` and the
 * per-machine `.claude/settings.local.json`, so a gate in either one is wired.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";

export interface PreToolUseGroup {
  matcher?: string;
  hooks?: { type?: string; command: string }[];
}

const SHARED_SETTINGS = ".claude/settings.json";
const LOCAL_SETTINGS = ".claude/settings.local.json";

/** The settings file a gate is written to: the local one when the shared one is tracked by git. */
export async function gateSettingsFile(cwd: string): Promise<string> {
  const tracked = await execFileNoThrow(
    "git",
    ["ls-files", "--error-unmatch", "--", SHARED_SETTINGS],
    {
      cwd,
      timeout: 5_000,
    },
  );
  return tracked.ok ? LOCAL_SETTINGS : SHARED_SETTINGS;
}

function groupsIn(path: string): PreToolUseGroup[] {
  try {
    const settings = JSON.parse(readFileSync(path, "utf-8")) as {
      hooks?: Record<string, PreToolUseGroup[]>;
    };
    return Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  } catch {
    return []; // missing or unparseable settings hold no gates
  }
}

/** PreToolUse groups from a settings file and the settings.local.json beside it. */
export function preToolUseGroups(settingsPath: string): PreToolUseGroup[] {
  return [
    ...groupsIn(settingsPath),
    ...groupsIn(join(dirname(settingsPath), "settings.local.json")),
  ];
}
