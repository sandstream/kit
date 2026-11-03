import { existsSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

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
  const result = await installHook(hooksDir, hookName, commands);
  const where = insideWorkingTree(hooksDir, cwd);
  if (where && (result.action === "installed" || result.action === "updated")) {
    result.detail += `; ${where} is inside the working tree, so a new worktree gets only the tracked files: commit this hook or it will not run there`;
  }
  return result;
}

/** The hooks directory relative to the working tree when it lies in it (outside .git), else null. */
function insideWorkingTree(hooksDir: string, cwd: string): string | null {
  try {
    const rel = relative(realpathSync.native(cwd), realpathSync.native(hooksDir));
    const first = rel.split(sep)[0];
    const inside = rel !== "" && first !== ".." && first !== ".git";
    return inside ? rel : null;
  } catch {
    return null;
  }
}
