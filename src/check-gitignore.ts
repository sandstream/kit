/**
 * .gitignore validator. Checks that the project's `.gitignore` covers the
 * paths that historically leak credentials when accidentally committed.
 *
 * Two operations:
 *   - `verify(cwd)` — returns the list of patterns that should be present
 *                     but aren't
 *   - `patch(cwd)`  — appends missing entries to `.gitignore` (or creates
 *                     the file). Idempotent — re-running is a no-op.
 *
 * `.gitignore` semantics are minimal here: we string-match by line, ignore
 * comments, and require an exact pattern match (no globbing equivalence —
 * if the user has `**.env*` instead of `.env*`, kit still nudges them).
 */

import { readFile, writeFile, access, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface IgnoreCheckResult {
  exists: boolean;
  presentPatterns: string[];
  missingPatterns: { pattern: string; reason: string }[];
}

interface RequiredEntry {
  pattern: string;
  reason: string;
  /** Aliases that also satisfy this entry (e.g. `**.env*` works for `.env*`). */
  aliases?: string[];
}

const REQUIRED_PATTERNS: RequiredEntry[] = [
  { pattern: ".env", reason: "default dotenv file", aliases: [".env*", "**/.env"] },
  { pattern: ".env.local", reason: "local secrets materialized by kit secrets", aliases: [".env*"] },
  { pattern: ".env.*.local", reason: "per-env local secrets", aliases: [".env*"] },
  { pattern: "node_modules", reason: "dependency tree", aliases: ["node_modules/"] },
  // Ignore kit's local-state CONTENTS via `.kit/*` (not the wholesale `.kit/`):
  // git won't descend into a wholesale-excluded dir, so a later `!.kit/shared/`
  // negation cannot re-include the curated, committed-by-design shared tier
  // (.kit/shared/memory.jsonl). `.kit/*` ignores the contents while leaving the
  // dir descendable, so the negation below works.
  { pattern: ".kit/*", reason: "kit local state (elevation, env, runtime)", aliases: [".kit", ".kit/", ".kit/*"] },
  { pattern: "!.kit/shared/", reason: "keep curated shared memory tracked (committed by design)", aliases: ["!.kit/shared", "!.kit/shared/**"] },
  { pattern: ".kit-audit.jsonl", reason: "audit log can contain secret labels + paths" },
  { pattern: "*.pem", reason: "PEM keys / certs" },
  { pattern: "*.key", reason: "private keys" },
  { pattern: "id_rsa", reason: "SSH private key", aliases: ["id_rsa*"] },
  { pattern: "id_ed25519", reason: "SSH ed25519 private key", aliases: ["id_ed25519*"] },
  { pattern: "*.p12", reason: "PKCS#12 bundle (TLS certs + keys)" },
  { pattern: "*-service-account*.json", reason: "GCP service-account JSON keys" },
];

function parseGitignore(text: string): string[] {
  return text
    .split("\n")
    .map((l) => {
      // Strip inline comments (everything after first unescaped `#`),
      // matching how our patch helper writes `pattern  # reason`.
      const hashIdx = l.indexOf("#");
      const noComment = hashIdx >= 0 ? l.slice(0, hashIdx) : l;
      return noComment.trim();
    })
    .filter((l) => l.length > 0);
}

export async function checkGitignore(
  cwd: string = process.cwd(),
): Promise<IgnoreCheckResult> {
  const path = resolve(cwd, ".gitignore");
  let exists = false;
  let lines: string[] = [];
  try {
    await access(path);
    exists = true;
    const text = await readFile(path, "utf-8");
    lines = parseGitignore(text);
  } catch {
    // file missing — every required pattern is "missing"
  }

  const present = new Set(lines);
  const missing: { pattern: string; reason: string }[] = [];
  const matched: string[] = [];

  for (const entry of REQUIRED_PATTERNS) {
    const candidates = [entry.pattern, ...(entry.aliases ?? [])];
    const found = candidates.find((p) => present.has(p));
    if (found) {
      matched.push(entry.pattern);
    } else {
      missing.push({ pattern: entry.pattern, reason: entry.reason });
    }
  }

  return {
    exists,
    presentPatterns: matched,
    missingPatterns: missing,
  };
}

/**
 * Appends the missing patterns to `.gitignore`, creating the file if needed.
 * Adds a single kit-managed block at the bottom so we can recognize it on
 * re-runs and not duplicate.
 */
export async function patchGitignore(
  cwd: string = process.cwd(),
): Promise<{ added: number; written: boolean }> {
  const result = await checkGitignore(cwd);
  if (result.missingPatterns.length === 0) {
    return { added: 0, written: false };
  }
  const path = resolve(cwd, ".gitignore");
  let existing = "";
  try {
    await access(path);
    existing = await readFile(path, "utf-8");
  } catch {
    existing = "";
  }

  // Find the kit-managed block; replace it if present so the same patch
  // command stays idempotent.
  const MARKER_START = "# ── kit security check-gitignore ── do not edit ──";
  const MARKER_END = "# ── /kit ──";
  const block = [
    MARKER_START,
    ...result.missingPatterns.map((m) => `${m.pattern}  # ${m.reason}`),
    MARKER_END,
    "",
  ].join("\n");

  let next: string;
  if (existing.includes(MARKER_START) && existing.includes(MARKER_END)) {
    const before = existing.split(MARKER_START)[0].trimEnd();
    const after = existing.split(MARKER_END)[1] ?? "";
    next = `${before}\n\n${block}${after}`;
  } else {
    const trimmed = existing.trimEnd();
    next = trimmed.length > 0 ? `${trimmed}\n\n${block}` : block;
  }
  await writeFile(path, next, "utf-8");
  return { added: result.missingPatterns.length, written: true };
}

/**
 * Lightweight tracked-file scanner — walks the git index for paths that
 * SHOULD have been ignored but aren't. Returns the offending tracked
 * filenames. Useful for the "already committed before .gitignore was set
 * up" case where adding the pattern doesn't help.
 */
export async function findCommittedSensitive(
  cwd: string = process.cwd(),
): Promise<string[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout } = await exec(
      "git",
      ["ls-files"],
      { cwd, timeout: 5_000 },
    );
    const tracked = stdout.split("\n").filter(Boolean);
    const offenders: string[] = [];
    for (const path of tracked) {
      const base = path.split("/").pop() ?? path;
      // `.env`, `.env.local`, `.env.local.prod-backup`, etc.
      // Excluded as harmless: any path that ends in `.template`,
      // `.example`, `.sample` (covers `.env.staging.example` too).
      if (
        /^\.env(\..+)?$/.test(base) &&
        !/\.(template|example|sample)$/.test(base)
      ) offenders.push(path);
      if (base.endsWith(".pem") || base.endsWith(".key") || base.endsWith(".p12")) offenders.push(path);
      if (base === "id_rsa" || base.startsWith("id_rsa.")) offenders.push(path);
      if (base === "id_ed25519" || base.startsWith("id_ed25519.")) offenders.push(path);
      if (/-service-account.*\.json$/.test(base)) offenders.push(path);
    }
    return [...new Set(offenders)];
  } catch {
    return [];
  }
}

// Suppress unused-import warning for stat — kept for future size-cap checks.
void stat;
