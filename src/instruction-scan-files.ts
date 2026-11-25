import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  opendirSync,
  readSync,
  type Dir,
  type Dirent,
} from "node:fs";
import { join, relative, sep } from "node:path";

const INSTRUCTION_NAMES = new Set([
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "GEMINI.md",
  "SKILL.md",
  ".cursorrules",
  ".windsurfrules",
  "copilot-instructions.md",
]);
/** `.agents` holds Codex repository skills (`.agents/skills/<name>/SKILL.md`). */
const INSTRUCTION_DOT_DIRS = new Set([
  ".claude",
  ".cursor",
  ".github",
  ".codex",
  ".gemini",
  ".agents",
]);
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "vendor", "target", "coverage"]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 20_000;
const MAX_FILES = 500;
const MAX_BYTES = 1_000_000;

export interface InstructionCoverageGap {
  path: string;
  reason: "directory-read" | "depth-limit" | "entry-limit" | "file-limit" | "finding-limit";
}

interface DiscoveryState {
  files: string[];
  coverageGaps: InstructionCoverageGap[];
  seen: number;
  stopped: boolean;
  match: (relPath: string) => boolean;
}

/** INSTRUCTION_NAMES lower-cased: macOS and Windows open `agents.md` when an agent asks for `AGENTS.md`. */
const INSTRUCTION_NAMES_LOWER = new Set([...INSTRUCTION_NAMES].map((n) => n.toLowerCase()));

export function isInstructionFile(relPath: string): boolean {
  const parts = relPath.split(/[\\/]+/);
  const name = parts.at(-1) ?? "";
  if (INSTRUCTION_NAMES_LOWER.has(name.toLowerCase())) return true;
  if (name.endsWith(".mdc") && parts.includes(".cursor") && parts.includes("rules")) return true;
  // Claude Code loads every `.md` under `.claude/rules/`, recursively (code.claude.com/docs/en/memory).
  const claude = parts.indexOf(".claude");
  return name.endsWith(".md") && claude !== -1 && parts[claude + 1] === "rules";
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/") || ".";
}

function omittedDirectory(name: string): boolean {
  return SKIPPED_DIRS.has(name) || (name.startsWith(".") && !INSTRUCTION_DOT_DIRS.has(name));
}

function visit(
  root: string,
  abs: string,
  depth: number,
  entry: Dirent,
  state: DiscoveryState,
): void {
  const path = join(abs, entry.name);
  const rel = relativePath(root, path);
  if (state.match(rel)) {
    if (state.files.length < MAX_FILES) state.files.push(rel);
    else {
      state.coverageGaps.push({ path: rel, reason: "file-limit" });
      state.stopped = true;
    }
  } else if (entry.isDirectory() && !omittedDirectory(entry.name)) {
    if (depth < MAX_DEPTH) walk(root, path, depth + 1, state);
    else state.coverageGaps.push({ path: rel, reason: "depth-limit" });
  }
}

function walk(root: string, abs: string, depth: number, state: DiscoveryState): void {
  let directory: Dir | undefined;
  const path = relativePath(root, abs);
  try {
    directory = opendirSync(abs);
    while (!state.stopped) {
      const entry = directory.readSync();
      if (!entry) break;
      if (++state.seen > MAX_ENTRIES) {
        state.coverageGaps.push({ path, reason: "entry-limit" });
        state.stopped = true;
      } else visit(root, abs, depth, entry, state);
    }
  } catch {
    state.coverageGaps.push({ path, reason: "directory-read" });
  } finally {
    try {
      directory?.closeSync();
    } catch {
      state.coverageGaps.push({ path, reason: "directory-read" });
    }
  }
}

/**
 * Discover files and preserve every traversal failure or reached limit. `match` widens or narrows
 * which repo-relative paths count; the default is the files an agent loads as instructions.
 */
export function discoverInstructionFiles(
  root: string,
  match: (relPath: string) => boolean = isInstructionFile,
): {
  files: string[];
  coverageGaps: InstructionCoverageGap[];
} {
  const state: DiscoveryState = { files: [], coverageGaps: [], seen: 0, stopped: false, match };
  walk(root, root, 0, state);
  return { files: state.files.sort(), coverageGaps: state.coverageGaps };
}

/** File-list convenience API. Use discoverInstructionFiles to assess coverage. */
export function findInstructionFiles(root: string): string[] {
  return discoverInstructionFiles(root).files;
}

function readBounded(fd: number): string | null {
  const buffer = Buffer.alloc(65_536);
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_BYTES) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, MAX_BYTES + 1 - total), null);
    if (count === 0) return Buffer.concat(chunks, total).toString("utf8");
    total += count;
    if (total > MAX_BYTES) return null;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return null;
}

/** Follow file symlinks, refuse special files, and bound the actual bytes read. */
export function readInstructionFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  let text: string | null = null;
  try {
    const stat = fstatSync(fd);
    if (stat.isFile() && stat.size <= MAX_BYTES) text = readBounded(fd);
  } catch {
    text = null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      text = null;
    }
  }
  return text;
}
