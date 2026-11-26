/**
 * Which file a bare command name runs, found without spawning `which` or `where`.
 *
 * The vendor-CLI pin has to name the exact file a bare `op` would start, so it walks PATH itself:
 * no subprocess, and no dependence on which `which` a host ships.
 *
 * - POSIX: each PATH entry in order; an empty or relative entry is resolved against `cwd`,
 *   because that is what the shell does and it is exactly how a `./op` shadows the real one.
 * - Windows: the current directory is tried first, then each PATH entry, and in each directory
 *   the bare name followed by every PATHEXT extension (default `.COM;.EXE;.BAT;.CMD`). The
 *   current-directory step mirrors libuv's `search_path`, which Node's `execFile` uses. That is
 *   reasoning from libuv's source, not measured here: no CI job runs this walk against a real
 *   Windows `execFile`.
 *
 * Pure apart from the injected `isFile` probe; `platform` picks `node:path`'s win32 or posix
 * flavour so both are testable on any host.
 */
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface PathLookupEnv {
  PATH?: string;
  Path?: string;
  PATHEXT?: string;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function defaultIsFile(p: string): boolean {
  try {
    // Executable, as a shell requires: a non-executable `op` earlier on PATH is skipped.
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Every file a bare `tool` could be, in the order the platform tries them. */
export function pathCandidates(
  tool: string,
  env: PathLookupEnv,
  platform: NodeJS.Platform,
  cwd: string,
): string[] {
  const win = platform === "win32";
  const p = win ? win32 : posix;
  const raw = env.PATH ?? env.Path ?? "";
  const dirs = raw.split(win ? ";" : ":").map((d) => p.resolve(cwd, d.replace(/^"|"$/g, "")));
  if (!win) return dirs.map((d) => p.join(d, tool));
  const exts = (env.PATHEXT || DEFAULT_PATHEXT).split(";").filter(Boolean);
  const hasExt = exts.some((e) => tool.toLowerCase().endsWith(e.toLowerCase()));
  const names = hasExt ? [tool] : exts.map((e) => tool + e.toLowerCase());
  return [cwd, ...dirs].flatMap((d) => names.map((n) => p.join(d, n)));
}

/** The first candidate that is a file, or null. A name with a separator is not looked up. */
export function findOnPath(
  tool: string,
  env: PathLookupEnv,
  platform: NodeJS.Platform,
  cwd: string,
  isFile: (p: string) => boolean = defaultIsFile,
): string | null {
  if (/[\\/]/.test(tool)) return null;
  for (const candidate of pathCandidates(tool, env, platform, cwd)) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}
