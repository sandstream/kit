/**
 * Cline's auto-approve setting that runs shell commands without asking anyone: Cline's counterpart
 * of Claude Code's `bypassPermissions`, which `kit agent-audit` reports for Claude.
 *
 * Evidence (cline/cline `main`, read 2026-11-28):
 *   - `apps/vscode/src/shared/storage/storage-context.ts`: state lives in `<dataDir>/globalState.json`,
 *     where `dataDir` is `$CLINE_DATA_DIR`, else `$CLINE_DIR/data`, else `~/.cline/data`. The VS Code
 *     extension, the CLI and JetBrains share it.
 *   - `apps/vscode/src/shared/AutoApprovalSettings.ts`: the `autoApprovalSettings` key, with
 *     `actions.executeSafeCommands` ("Execute commands") and the legacy `actions.executeAllCommands`.
 *   - `apps/vscode/src/sdk/sdk-tool-policies.ts` `isToolAutoApproved`: `run_commands` and
 *     `execute_command` are approved when `executeSafeCommands` is true. Older builds approved only
 *     the commands the model marked safe unless `executeAllCommands` was also true.
 *   - `apps/vscode/webview-ui/src/components/chat/auto-approve-menu/constants.ts`: the menu labels
 *     `executeSafeCommands` "Execute commands".
 *   - `apps/vscode/src/hosts/vscode/vscode-to-file-migration.ts`: the removed `yoloModeToggled` and
 *     `autoApproveAllToggled` toggles approved everything; they stay in the file and older builds
 *     still read them.
 *
 * Not read: Cline's VS Code memento (`state.vscdb`, SQLite) of builds from before the file store,
 * and the CLI's command-line flags. Read-only; a missing or unparsable file gives no row.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";

/** What turns Cline's command approval off, as the file spells it, or null. Pure. */
export function clineAutoApprovesCommands(globalState: unknown): string | null {
  if (typeof globalState !== "object" || globalState === null) return null;
  const state = globalState as Record<string, unknown>;
  for (const key of ["yoloModeToggled", "autoApproveAllToggled"])
    if (state[key] === true) return `${key}: true`;
  const settings = state.autoApprovalSettings as { actions?: Record<string, unknown> } | undefined;
  const actions = settings?.actions ?? {};
  if (actions.executeSafeCommands === true)
    return "autoApprovalSettings.actions.executeSafeCommands: true";
  if (actions.executeAllCommands === true)
    return "autoApprovalSettings.actions.executeAllCommands: true";
  return null;
}

/** Cline's data directory and how it is shown, by Cline's own precedence. Pure. */
export function clineDataDir(
  home: string,
  env: Record<string, unknown>,
): { dir: string; shown: string } {
  const set = (k: string) => (typeof env[k] === "string" ? String(env[k]).trim() : "");
  if (set("CLINE_DATA_DIR")) return { dir: set("CLINE_DATA_DIR"), shown: "$CLINE_DATA_DIR" };
  if (set("CLINE_DIR")) return { dir: join(set("CLINE_DIR"), "data"), shown: "$CLINE_DIR/data" };
  return { dir: join(home, ".cline", "data"), shown: "~/.cline/data" };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

/** `kit check` / `kit agent-audit` row: warn when Cline runs every command without asking. */
export function checkClineAutoApprove(
  home: string = homedir(),
  env: Record<string, unknown> = process.env,
): SecurityCheckResult[] {
  const { dir, shown } = clineDataDir(home, env);
  const file = `${shown}/globalState.json`;
  const state = readJson(join(dir, "globalState.json"));
  if (state === null) return [];
  const found = clineAutoApprovesCommands(state);
  if (!found)
    return [
      {
        category: "exposure",
        name: "cline auto-approve",
        status: "pass",
        detail: `Cline asks before it runs a command (${file})`,
      },
    ];
  return [
    {
      category: "exposure",
      name: "cline auto-approve",
      status: "warn",
      severity: "high",
      detail:
        `Cline runs shell commands without asking anyone (${found}, in ${file}), as Claude Code ` +
        "does with bypassPermissions",
      suggestion:
        'turn off "Execute commands" in Cline\'s auto-approve menu, so a person approves each command',
    },
  ];
}
