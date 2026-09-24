/**
 * .gitignore validator. Checks that the project's `.gitignore` covers the
 * paths that historically leak credentials when accidentally committed.
 *
 * Git evaluates representative paths and lists exposed or already tracked
 * sensitive files. Verification errors are explicit; pattern text alone is
 * never evidence of protection.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

export interface IgnoreCheckResult {
  exists: boolean;
  presentPatterns: string[];
  missingPatterns: { pattern: string; reason: string }[];
  trackedFiles: string[];
  unignoredFiles: string[];
}

interface RequiredEntry {
  pattern: string;
  reason: string;
  /** Concrete paths for Git to evaluate; never pass globs to check-ignore. */
  paths?: string[];
}

const ENV_PATTERNS: RequiredEntry[] = [
  { pattern: ".env", reason: "default dotenv file" },
  {
    pattern: ".env.local",
    reason: "local secrets materialized by kit secrets",
  },
  {
    pattern: ".env.*.local",
    reason: "per-env local secrets",
    paths: [".env.production.local", ".env.development.local", ".env.test.local"],
  },
  {
    // The dotenvx PRIVATE keys: whoever has this file decrypts every encrypted .env in
    // the repo, so committing it surrenders exactly what the encryption was protecting.
    // `*.key` does not cover it (this ends in `.keys`), and a repo that lists the three
    // classic .env patterns literally satisfied every check while leaving it trackable.
    pattern: ".env.keys",
    reason: "dotenvx private keys (decrypt every encrypted .env)",
  },
];

const REQUIRED_PATTERNS: RequiredEntry[] = [
  ...ENV_PATTERNS,
  {
    pattern: ".env.local.*",
    reason: "local secrets backups",
    paths: [".env.local.prod-backup"],
  },
  {
    pattern: ".env.*.backup",
    reason: "per-env secrets backups",
    paths: [".env.production.backup"],
  },
  { pattern: "*.prod-backup", reason: "production backups", paths: ["secrets.prod-backup"] },
  {
    pattern: "node_modules",
    reason: "dependency tree",
    paths: ["node_modules/kit-ignore-probe/index.js"],
  },
  // Ignore kit's local-state CONTENTS via `.kit/*` (not the wholesale `.kit/`):
  // git won't descend into a wholesale-excluded dir, so a later `!.kit/shared/`
  // negation cannot re-include the curated, committed-by-design shared tier
  // (.kit/shared/memory.jsonl). `.kit/*` ignores the contents while leaving the
  // dir descendable, so the negation below works.
  {
    pattern: ".kit/*",
    reason: "kit local state (elevation, env, runtime)",
    paths: [".kit/elevation.json", ".kit/env/local", ".kit/runtime/state"],
  },
  {
    pattern: "!.kit/shared/",
    reason: "keep curated shared memory tracked (committed by design)",
    paths: [".kit/shared/memory.jsonl"],
  },
  { pattern: ".kit-audit.jsonl", reason: "audit log can contain secret labels + paths" },
  { pattern: ".kit-audit.pending", reason: "pending audit records" },
  { pattern: ".kit-skipped-commits.jsonl", reason: "local bypass records" },
  { pattern: "*.pem", reason: "PEM keys / certs", paths: ["server.pem"] },
  { pattern: "*.key", reason: "private keys", paths: ["server.key"] },
  { pattern: "id_rsa", reason: "SSH private key" },
  { pattern: "id_ed25519", reason: "SSH ed25519 private key" },
  { pattern: "*.p12", reason: "PKCS#12 bundle (TLS certs + keys)", paths: ["bundle.p12"] },
  {
    pattern: "*-service-account*.json",
    reason: "GCP service-account JSON keys",
    paths: ["gcp-service-account-prod.json"],
  },
];

function git(cwd: string, args: string[], input?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  // Hooks can export an index or worktree belonging to the calling repository.
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
  ])
    delete env[key];
  return new Promise((resolveOutput, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (
          error &&
          !(args[0] === "check-ignore" && error.code === 1 && !error.killed && !error.signal)
        ) {
          reject(
            new Error(
              `Git ${args[0]} failed (${error.code ?? error.signal ?? "unknown error"}); ignore protection could not be verified`,
            ),
          );
        } else {
          resolveOutput(stdout);
        }
      },
    );
    // A failed spawn can close stdin before the NUL-delimited paths are written.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

async function requireWorktree(cwd: string): Promise<void> {
  if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") {
    throw new Error("Git working tree unavailable; ignore protection could not be verified");
  }
}

function isEnvSecret(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return /^\.env(\..+)?$/.test(base) && !/\.(template|example|sample)$/.test(base);
}

function isSensitive(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return (
    isEnvSecret(path) ||
    /\.(pem|key|p12|prod-backup)$/.test(base) ||
    /^id_(rsa|ed25519)(\.|$)/.test(base) ||
    /-service-account.*\.json$/.test(base)
  );
}

async function inspectPatterns(
  cwd: string,
  entries: RequiredEntry[],
  sensitive: (path: string) => boolean,
): Promise<IgnoreCheckResult> {
  await requireWorktree(cwd);
  const trackedFiles = (await git(cwd, ["ls-files", "--cached", "-z"]))
    .split("\0")
    .filter((path) => path && sensitive(path));
  const unignoredFiles = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((path) => path && sensitive(path));
  const paths = entries.flatMap((entry) => entry.paths ?? [entry.pattern]);
  // --no-index measures the rules; tracked files are independently rejected above.
  const ignored = new Set(
    (await git(cwd, ["check-ignore", "--no-index", "-z", "--stdin"], `${paths.join("\0")}\0`))
      .split("\0")
      .filter(Boolean),
  );
  const missing: { pattern: string; reason: string }[] = [];
  const matched: string[] = [];
  for (const entry of entries) {
    const shouldIgnore = !entry.pattern.startsWith("!");
    if ((entry.paths ?? [entry.pattern]).every((path) => ignored.has(path) === shouldIgnore)) {
      matched.push(entry.pattern);
    } else {
      missing.push({ pattern: entry.pattern, reason: entry.reason });
    }
  }
  for (const path of unignoredFiles) {
    if (!missing.some((entry) => entry.pattern === path)) {
      missing.push({ pattern: path, reason: "sensitive file is not ignored by Git" });
    }
  }
  for (const path of trackedFiles) {
    missing.push({
      pattern: path,
      reason: "sensitive file is already tracked by Git; ignore rules cannot untrack it",
    });
  }
  return {
    exists: await access(resolve(cwd, ".gitignore")).then(
      () => true,
      () => false,
    ),
    presentPatterns: matched,
    missingPatterns: missing,
    trackedFiles,
    unignoredFiles,
  };
}

export async function checkGitignore(cwd: string = process.cwd()): Promise<IgnoreCheckResult> {
  return inspectPatterns(cwd, REQUIRED_PATTERNS, isSensitive);
}

export async function checkEnvIgnoreProtection(cwd: string): Promise<IgnoreCheckResult> {
  // Keep the security gate's established dotenv floor; broader backup protection is repaired by fix.
  return inspectPatterns(cwd, ENV_PATTERNS, isEnvSecret);
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
  let existing: string;
  try {
    existing = await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = "";
  }

  // Find the kit-managed block; replace it if present so the same patch
  // command stays idempotent.
  const MARKER_START = "# ── kit security check-gitignore ── do not edit ──";
  const MARKER_END = "# ── /kit ──";
  // The reason goes on its OWN line above the pattern. `.gitignore` has no trailing-comment
  // syntax (gitignore(5): a comment is a line starting with `#`), so the previous
  // `pattern  # reason` form made every entry a literal pattern matching a filename that
  // contains " # reason" — 12 patterns written, 0 honored by git, and the checker read its own
  // annotations back and called it green.
  const extra = result.unignoredFiles.filter(
    (path) => !REQUIRED_PATTERNS.some((entry) => entry.pattern === path),
  );
  if (extra.some((path) => /[\r\n]/.test(path))) {
    throw new Error("Gitignore repair requires manual review: a sensitive path contains a newline");
  }
  const lines = existing.split("\n");
  const start = lines.findIndex((line) => line.replace(/\r$/, "") === MARKER_START);
  const end = lines.findIndex((line, i) => i > start && line.replace(/\r$/, "") === MARKER_END);
  // Literal repairs from earlier runs may cover filenames beyond the standard probes.
  const previousExtras =
    start >= 0 && end > start
      ? lines.slice(start + 1, end).filter((line) => line.startsWith("/"))
      : [];
  const block = [
    MARKER_START,
    ...previousExtras,
    // Reopen only the root parent; nested .kit directories retain their protection.
    "!/.kit/",
    ...REQUIRED_PATTERNS.flatMap((m) => [`# ${m.reason}`, m.pattern]),
    ...extra.map((path) => `/${path.replace(/[\\*?[\] ]/g, "\\$&")}`),
    MARKER_END,
    "",
  ].join("\n");

  if (start >= 0 && end > start) {
    lines.splice(start, end - start + 1);
  }
  // Preserve user lines, but place the complete block after any later negations.
  const remaining = lines.join("\n");
  const next = `${remaining}${remaining && !remaining.endsWith("\n") ? "\n" : ""}${block}`;
  await writeFile(path, next, "utf-8");
  const verified = await checkGitignore(cwd);
  if (verified.missingPatterns.length > 0) {
    throw new Error(
      `Gitignore repair incomplete: ${verified.missingPatterns.map((entry) => `${JSON.stringify(entry.pattern)} (${entry.reason})`).join(", ")}`,
    );
  }
  return { added: result.missingPatterns.length, written: true };
}

/**
 * Lightweight tracked-file scanner — walks the git index for paths that
 * SHOULD have been ignored but aren't. Returns the offending tracked
 * filenames. Useful for the "already committed before .gitignore was set
 * up" case where adding the pattern doesn't help.
 */
export async function findCommittedSensitive(cwd: string = process.cwd()): Promise<string[]> {
  await requireWorktree(cwd);
  return [
    ...new Set(
      (await git(cwd, ["ls-files", "--cached", "-z"]))
        .split("\0")
        .filter((path) => path && isSensitive(path)),
    ),
  ];
}
