/**
 * kit memory — current-project resolution.
 *
 * Memory search defaults to the current project (relevance + blast-radius
 * containment); the repo root is the project boundary. Falls back to cwd when not
 * inside a git repo. Pure read — no model calls, no writes.
 */
import { execFileSync } from "node:child_process";

export function getCurrentProjectRoot(cwd: string = process.cwd()): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) return root;
  } catch {
    // not a git repo (or git unavailable) — fall back to cwd
  }
  return cwd;
}
