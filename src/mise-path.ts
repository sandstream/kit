/**
 * mise-on-PATH detection + activation (#64).
 *
 * kit installs tools via mise, but their shims are only reachable as bare commands
 * if mise's shims dir is on the shell's PATH. `eval "$(mise activate)"` is fragile
 * (no-ops if mise itself isn't on PATH yet when the profile runs), so kit prefers
 * putting the shims dir directly on PATH. Pure helpers here; `kit doctor` reports a
 * gap and `kit setup --activate-mise` appends the line (idempotent, consented).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function miseShimsDir(home = homedir()): string {
  return join(home, ".local", "share", "mise", "shims");
}

/** Is `dir` an exact entry in a `:`-separated PATH string? */
export function isDirOnPath(pathEnv: string | undefined, dir: string): boolean {
  return (pathEnv ?? "").split(":").some((p) => p === dir);
}

/** The profile line that makes mise tools resolve as bare commands. */
export function activationLine(shimsDir: string): string {
  return `export PATH="${shimsDir}:$PATH"`;
}

/** True when the profile doesn't already put the shims dir on PATH (or activate mise). */
export function profileNeedsActivation(content: string, shimsDir: string): boolean {
  return !content.includes(shimsDir) && !/mise activate/.test(content);
}

/** Append the activation line to a shell profile if absent. Returns what it did. */
export function ensureMiseActivation(profilePath: string, shimsDir: string): "added" | "already" {
  const existing = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
  if (!profileNeedsActivation(existing, shimsDir)) return "already";
  const block = `\n# kit: put mise's shims on PATH so its tools resolve in every shell\n${activationLine(shimsDir)}\n`;
  writeFileSync(profilePath, existing + block);
  return "added";
}
