import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { basename, dirname } from "node:path";
import { getCurrentProjectRoot } from "./project.js";

/**
 * The main checkout of the repository `cwd` belongs to: the same path from every linked
 * worktree. Findings that are not about the code share this scope so one worktree does not
 * raise a copy of what another already tracks. Falls back to the current root outside git,
 * for a bare repository, or when git cannot answer.
 */
export function getCanonicalProjectRoot(cwd: string = process.cwd()): string {
  const common = gitCommonDir(cwd);
  if (common && basename(common) === ".git") return dirname(common);
  return getCurrentProjectRoot(cwd);
}

function gitCommonDir(cwd: string): string {
  const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  const opts: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  };
  try {
    return execFileSync("git", args, opts).trim();
  } catch {
    return ""; // not a git repo, or git too old for --path-format
  }
}
