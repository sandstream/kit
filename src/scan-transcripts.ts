import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { findSecrets, type SecretFinding } from "./utils/redactSecrets.js";

/**
 * Scans agent transcript and prompt-cache directories for leaked credentials.
 *
 * Why this matters: an AI agent receives a real key in conversation history,
 * the message gets persisted to a transcript file, and that file gets read
 * back into every future prompt. The key keeps re-leaking until the transcript
 * is purged.
 *
 * Scans:
 *   - `<repo>/.claude/`           — project-local Claude Code state
 *   - `<repo>/.opencode/`         — OpenCode local state
 *   - `~/.claude/projects/<repo>/` — global Claude Code project cache
 *   - `~/.claude/projects/-<repo-path>/` — same, with normalized slashes
 *
 * Files we read: `*.jsonl`, `*.md`, `*.json`, `*.txt` (transcript-shaped).
 * Skipped: binary, large blobs over 10 MiB, node_modules.
 */
export interface TranscriptHit {
  file: string;
  findings: SecretFinding[];
}

const SCANNABLE_EXTS = new Set([".jsonl", ".md", ".json", ".txt", ".log"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "tool-results"]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

async function dirExists(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function walk(dir: string, out: string[], depth = 0, maxDepth = 6): Promise<void> {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      await walk(full, out, depth + 1, maxDepth);
    } else if (ent.isFile()) {
      const ext = ent.name.includes(".") ? ent.name.slice(ent.name.lastIndexOf(".")) : "";
      if (!SCANNABLE_EXTS.has(ext)) continue;
      out.push(full);
    }
  }
}

/**
 * Convert an absolute repo path into the slug Claude Code uses for its
 * `~/.claude/projects/<slug>/` directory: leading dash, then path with `/`
 * replaced by `-`. Best-effort — both forms are checked.
 */
function repoSlug(cwd: string): string {
  return cwd.replace(/^\//, "-").replace(/\//g, "-");
}

export async function scanTranscripts(cwd: string = process.cwd()): Promise<TranscriptHit[]> {
  const candidates: string[] = [];

  // Project-local agent dirs
  for (const local of [".claude", ".opencode", ".cursor", ".aider"]) {
    const full = resolve(cwd, local);
    if (await dirExists(full)) candidates.push(full);
  }

  // Global Claude Code project cache (best-effort slug match)
  const home = homedir();
  const slug = repoSlug(cwd);
  for (const global of [
    join(home, ".claude", "projects", slug),
    join(home, ".opencode", "projects", slug),
  ]) {
    if (await dirExists(global)) candidates.push(global);
  }

  const files: string[] = [];
  for (const root of candidates) {
    await walk(root, files);
  }

  const hits: TranscriptHit[] = [];
  for (const path of files) {
    let content: string;
    try {
      const st = await stat(path);
      if (st.size > MAX_BYTES) continue;
      content = await readFile(path, "utf-8");
    } catch {
      continue;
    }
    const findings = findSecrets(content);
    if (findings.length > 0) {
      hits.push({ file: path, findings });
    }
  }
  return hits;
}
