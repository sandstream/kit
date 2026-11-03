import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { installHook, resolveHooksDir, type HookInstallResult } from "./hooks.js";

/**
 * Install one hook and nothing else: not the bypass detector that `installHooks` always adds. For
 * the hooks kit installs by default, which must not drag a pre-commit sentinel into a repository
 * that never asked for one. Does nothing outside a git repository, so no `.git` is ever created.
 */
export async function installOneHook(
  hookName: string,
  commands: string[],
  gitDir = ".git",
  cwd = process.cwd(),
): Promise<HookInstallResult> {
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) return { hookName, action: "skipped", detail: "read-only mode" };
  if (!existsSync(resolve(cwd, ".git"))) {
    return { hookName, action: "skipped", detail: "not a git repository" };
  }
  const hooksDir = resolveHooksDir(gitDir, cwd);
  try {
    await mkdir(hooksDir, { recursive: true });
  } catch (error) {
    return { hookName, action: "failed", detail: `Failed to create hooks directory: ${error}` };
  }
  return installHook(hooksDir, hookName, commands);
}
