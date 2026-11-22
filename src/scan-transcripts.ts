import { isUtf8 } from "node:buffer";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ScannerEvidenceStatus } from "./check-scanner-evidence.js";
import { findSecrets, type SecretFinding } from "./utils/redactSecrets.js";
import { sameIdentity } from "./utils/same-file.js";

export interface TranscriptHit {
  file: string;
  findings: SecretFinding[];
}

type TranscriptGap =
  "unreadable" | "oversized" | "depth limit" | "unsupported" | "changed" | "malformed";

interface TranscriptInventory {
  hits: TranscriptHit[];
  directoriesScanned: number;
  filesScanned: number;
  gaps: Partial<Record<TranscriptGap, number>>;
}

export interface TranscriptScan extends TranscriptInventory {
  evidenceStatus: ScannerEvidenceStatus;
}

const SCANNABLE_EXTS = new Set([".jsonl", ".md", ".json", ".txt", ".log"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "tool-results", ".next"]);
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_DEPTH = 6;

function markGap(scan: TranscriptInventory, reason: TranscriptGap): void {
  scan.gaps[reason] = (scan.gaps[reason] ?? 0) + 1;
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function sampleBytes(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return bytes.subarray(0, offset);
}

function entryChanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    !sameIdentity(before, after) ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  );
}

async function scanOpenedFile(path: string, handle: FileHandle, scan: TranscriptInventory) {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) return markGap(scan, "unsupported");
  const entry = await lstat(path, { bigint: true });
  if (!entry.isFile() || !sameIdentity(before, entry)) return markGap(scan, "changed");
  if (before.size > BigInt(MAX_BYTES)) return markGap(scan, "oversized");

  const bytes = await sampleBytes(handle, Number(before.size));
  const findings = findSecrets(bytes.toString("utf8"));
  if (findings.length > 0) scan.hits.push({ file: path, findings });
  scan.filesScanned++;
  if (!isUtf8(bytes)) markGap(scan, "malformed");
  const after = await lstat(path, { bigint: true });
  if (bytes.length !== Number(before.size) || entryChanged(before, after)) markGap(scan, "changed");
}

async function scanFile(path: string, scan: TranscriptInventory): Promise<void> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      await scanOpenedFile(path, handle, scan);
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return markGap(scan, "changed");
    markGap(scan, code === "ELOOP" ? "unsupported" : "unreadable");
  }
}

async function walk(dir: string, scan: TranscriptInventory, depth: number): Promise<void> {
  if (depth > MAX_DEPTH) return markGap(scan, "depth limit");
  try {
    const before = await lstat(dir, { bigint: true });
    if (!before.isDirectory()) return markGap(scan, "unsupported");
    const entries = await readdir(dir, { withFileTypes: true });
    scan.directoriesScanned++;
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Agent sub-worktrees are copies of the repo. The source scan covers those files.
      if (entry.name === "worktrees" && basename(dir) === ".claude") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, scan, depth + 1);
      else if (SCANNABLE_EXTS.has(extname(entry.name))) {
        if (entry.isFile()) await scanFile(path, scan);
        else markGap(scan, "unsupported");
      }
    }
    if (entryChanged(before, await lstat(dir, { bigint: true }))) markGap(scan, "changed");
  } catch (error) {
    markGap(scan, codeOf(error) === "ENOENT" ? "changed" : "unreadable");
  }
}

async function scanRoot(path: string, scan: TranscriptInventory) {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) return markGap(scan, "unsupported");
  } catch (error) {
    if (codeOf(error) !== "ENOENT") markGap(scan, "unreadable");
    return;
  }
  await walk(path, scan, 0);
}

function transcriptEvidence(scan: TranscriptInventory): ScannerEvidenceStatus {
  const reasons = Object.keys(scan.gaps);
  if (reasons.length === 0) {
    if (scan.directoriesScanned === 0) return "missing";
    return scan.hits.length > 0 ? "complete" : "complete-empty";
  }
  if (reasons.length === 1 && scan.gaps.changed) return "stale";
  if (scan.directoriesScanned > 0) return "partial";
  return reasons.length === 1 && scan.gaps.unsupported ? "unsupported" : "unavailable";
}

/** Scan the configured project directories and matching local agent project caches. */
export async function scanTranscripts(cwd: string = process.cwd()): Promise<TranscriptScan> {
  const root = resolve(cwd);
  const slug = root.replace(/^\//, "-").replace(/\//g, "-");
  const home = homedir();
  const local = [".claude", ".opencode", ".cursor", ".aider", ".codex"];
  const caches = [".claude", ".opencode", ".codex"];
  const candidates = new Set([
    ...local.map((agent) => join(root, agent)),
    ...caches.map((agent) => join(home, agent, "projects", slug)),
  ]);
  const scan: TranscriptInventory = { hits: [], directoriesScanned: 0, filesScanned: 0, gaps: {} };
  for (const path of candidates) await scanRoot(path, scan);
  return { ...scan, evidenceStatus: transcriptEvidence(scan) };
}

export function transcriptCoverageDetail(scan: TranscriptScan): string {
  const { filesScanned, directoriesScanned } = scan;
  const files = filesScanned === 1 ? "file" : "files";
  const directories = directoriesScanned === 1 ? "directory" : "directories";
  const summary = `Scanned ${filesScanned} ${files} in ${directoriesScanned} ${directories}.`;
  const gaps = Object.entries(scan.gaps)
    .sort()
    .map(([reason, count]) => `${reason} (${count})`);
  return gaps.length === 0 ? summary : `${summary} Coverage unverified. ${gaps.join(", ")}.`;
}
