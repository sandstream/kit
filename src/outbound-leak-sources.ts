/**
 * Where `kit security scan-outbound` finds private and public agent instructions. Reuses kit's
 * existing instruction-file knowledge instead of a list of its own:
 *   - in the repository, `discoverInstructionFiles` (Claude Code, Codex, Gemini, Cursor, Windsurf
 *     and Copilot file names), widened by the two files that exist to stay unpublished: Codex's
 *     `AGENTS.override.md` and any `.md` under `.claude/`. A file git tracks is public; one it does
 *     not track (untracked or ignored) is private. Outside a git worktree nothing in the repo is
 *     known to be private, and the result says so.
 *   - at user level, `userInstructionFiles`: `~/.claude/CLAUDE.md` and the Claude user dirs, and
 *     Codex's `AGENTS.override.md`/`AGENTS.md` in `$CODEX_HOME` (default `~/.codex`) and its skill
 *     dirs. These are always private: no repository publishes them.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { userInstructionFiles } from "./agent-audit-user.js";
import {
  discoverInstructionFiles,
  isInstructionFile,
  readInstructionFile,
} from "./instruction-scan-files.js";
import type { PrivateSource } from "./outbound-leak.js";

/** The harnesses whose instruction files this reads, for help and `--json`. */
export const OUTBOUND_HARNESSES = ["Claude Code", "Codex"] as const;

/** An instruction file, or one of the two kinds that exist to stay local. Pure. */
export function isOutboundCandidate(relPath: string): boolean {
  if (isInstructionFile(relPath)) return true;
  const parts = relPath.split(/[\\/]+/);
  const name = (parts.at(-1) ?? "").toLowerCase();
  if (name === "agents.override.md") return true;
  return name.endsWith(".md") && parts.slice(0, -1).includes(".claude");
}

/**
 * The key a path is compared by: forward slashes, and lower case where the file system usually
 * ignores case (Windows, macOS), so git's `CLAUDE.md` and a walk's `claude.md` are one file. Pure.
 */
export function pathKey(relPath: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = relPath.split(/[\\/]+/).join("/");
  return platform === "win32" || platform === "darwin" ? slashed.toLowerCase() : slashed;
}

/** The worktree root and its tracked files, or null outside a git worktree. */
function gitTracked(cwd: string): { root: string; tracked: Set<string> } | null {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (top.status !== 0 || !top.stdout.trim()) return null;
  const root = top.stdout.trim();
  const listed = spawnSync("git", ["ls-files", "--cached", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (listed.status !== 0) return null;
  return {
    root,
    tracked: new Set(
      listed.stdout
        .split("\0")
        .filter(Boolean)
        .map((p) => pathKey(p)),
    ),
  };
}

export interface OutboundSources {
  privates: PrivateSource[];
  publicTexts: string[];
  /** Public instruction files, repo-relative. */
  publicFiles: string[];
  /** False outside a git worktree: then no repository file is known to be private. */
  git: boolean;
}

function repoSources(cwd: string, acc: OutboundSources): void {
  const git = gitTracked(cwd);
  acc.git = git !== null;
  const root = git?.root ?? cwd;
  for (const rel of discoverInstructionFiles(root, isOutboundCandidate).files) {
    const text = readInstructionFile(join(root, ...rel.split("/")));
    if (text === null) continue;
    if (!git || git.tracked.has(pathKey(rel))) {
      acc.publicTexts.push(text);
      acc.publicFiles.push(rel);
    } else acc.privates.push({ shown: rel, text });
  }
}

/** Every private and public instruction text for `cwd` and the user at `home`. */
export function outboundSources(
  cwd: string,
  home: string,
  env: Record<string, unknown> = process.env,
): OutboundSources {
  const acc: OutboundSources = { privates: [], publicTexts: [], publicFiles: [], git: false };
  repoSources(cwd, acc);
  for (const { abs, shown } of userInstructionFiles(home, env)) {
    const text = readInstructionFile(abs);
    if (text !== null) acc.privates.push({ shown, text });
  }
  return acc;
}
