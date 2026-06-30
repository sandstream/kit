/**
 * kit memory — private cross-device sync over a git remote (memory design gap #4).
 *
 * The personal store (~/.kit/memory.db) is per-machine; `syncFromExport` + an
 * encrypted backup blob already let you move it by hand. This wires that to a
 * concrete, opt-in transport — YOUR OWN private git repo — so machine A `push`es
 * and machine B `pull`s without a manual file copy. Last-write-wins via `mergeDb`.
 *
 * It is configurable WITHOUT being a backdoor, by construction:
 *   1. Config is read ONLY from ~/.kit/sync.toml (a LOCAL file) — never from the
 *      project tree. A malicious committed `.kit.toml`/`.kit/*` in a cloned repo
 *      therefore cannot redirect your private memory to an attacker's remote.
 *   2. The sync remote MUST differ from the current project's `origin` — your
 *      private brain can never be pushed into the project repo by mistake.
 *   3. The payload is AES-256-GCM encrypted (`backupEncrypted`); the remote only
 *      ever sees ciphertext. The passphrase comes from KIT_MEMORY_PASSPHRASE and
 *      is never stored.
 *   4. Opt-in: no ~/.kit/sync.toml → the command does nothing but explain setup.
 *
 * Deterministic, zero-LLM, zero new dependencies (node:child_process + git).
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { getMemoryDir, getMemoryDbPath, openMemoryDb } from "./db.js";
import { backupEncrypted } from "./backup.js";
import { syncFromExport } from "./sync.js";
import type { MergeResult } from "./merge.js";

/** How the encrypted blob travels. `git` = a private remote; `command` = your own shell command (S3/rclone/scp/USB/…). */
export type SyncTransport = "git" | "command";

export interface SyncConfig {
  transport: SyncTransport;
  /** Blob filename (default "memory.enc"). A bare name — no path. */
  file: string;
  // git transport
  /** The private git remote that stores the encrypted blob. */
  remote?: string;
  /** Branch to push/pull (default "main"). */
  branch?: string;
  // command transport — kit writes/reads the blob at $KIT_MEMORY_BLOB and runs your command.
  /** Shell command that UPLOADS the blob at $KIT_MEMORY_BLOB to your store. */
  pushCmd?: string;
  /** Shell command that DOWNLOADS the blob to $KIT_MEMORY_BLOB from your store. */
  pullCmd?: string;
}

const DEFAULT_BRANCH = "main";
const DEFAULT_FILE = "memory.enc";

/** Path to the LOCAL sync config — under ~/.kit, deliberately NOT in the repo tree. */
export function getSyncConfigPath(): string {
  return join(getMemoryDir(), "sync.toml");
}

/**
 * Load `[memory.sync]` from ~/.kit/sync.toml. Returns null when the file is
 * absent or carries no `remote` (sync is opt-in). Throws only on a malformed
 * blob filename (path-traversal guard).
 */
export function loadSyncConfig(): SyncConfig | null {
  const path = getSyncConfigPath();
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const memory = (root.memory ?? {}) as Record<string, unknown>;
  // Accept either `[memory.sync]` (preferred) or a top-level `[sync]`.
  const s = (memory.sync ?? root.sync ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const file = str(s.file) || DEFAULT_FILE;
  if (file.includes("/") || file.includes("\\") || file.includes("..")) {
    throw new Error(`invalid [memory.sync] file "${file}" — must be a bare filename`);
  }

  const transport: SyncTransport = s.transport === "command" ? "command" : "git";
  if (transport === "command") {
    const pushCmd = str(s.push_cmd);
    const pullCmd = str(s.pull_cmd);
    if (!pushCmd || !pullCmd) {
      throw new Error('[memory.sync] transport = "command" requires both push_cmd and pull_cmd');
    }
    return { transport, file, pushCmd, pullCmd };
  }

  const remote = str(s.remote);
  if (!remote) return null; // git transport with no remote → treat as unconfigured
  const branch = str(s.branch) || DEFAULT_BRANCH;
  return { transport, file, remote, branch };
}

/**
 * Normalize a git remote URL for equality comparison: lowercase, drop scheme,
 * userinfo, a trailing `.git` and trailing slashes, and fold the `git@host:owner`
 * SCP form to `host/owner`. So `git@github.com:me/x.git` and
 * `https://github.com/me/x` compare equal. Pure.
 */
export function normalizeRemote(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^[a-z0-9.+-]+:\/\//, ""); // strip scheme://
  u = u.replace(/^[^@/]+@/, ""); // strip user@ (ssh/scp)
  u = u.replace(/\.git$/, "").replace(/\/+$/, "");
  // SCP form host:owner/repo → host/owner/repo (only the FIRST colon, and only
  // when it isn't a :port). Leave host:port/path alone.
  u = u.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  return u;
}

function projectOrigin(root: string): string | null {
  try {
    return (
      execFileSync("git", ["-C", root, "remote", "get-url", "origin"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * Refuse to sync when the configured remote is the SAME repository as the current
 * project's `origin`. This is the core anti-exfiltration guard: your private,
 * secret-dense memory must travel to a SEPARATE private repo, never the (often
 * public, often shared) project repo. Throws on a match.
 */
export function assertRemoteNotProjectOrigin(remote: string, root: string): void {
  const origin = projectOrigin(root);
  if (origin && normalizeRemote(origin) === normalizeRemote(remote)) {
    throw new Error(
      `refusing to sync: [memory.sync] remote (${remote}) is THIS project's origin — ` +
        `private memory must go to a separate private repo, never the project repo`,
    );
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Get a working clone of the remote on the configured branch into `dir`. If the
 * remote/branch doesn't exist yet (first push), fall back to a fresh repo wired to
 * the remote so the initial push creates the branch.
 */
function cloneOrInit(remote: string, branch: string, dir: string): void {
  try {
    git(["clone", "--depth", "1", "--branch", branch, remote, "."], dir);
    return;
  } catch {
    // empty remote or missing branch — initialize a fresh repo targeting it
  }
  git(["init", "-q"], dir);
  git(["remote", "add", "origin", remote], dir);
  git(["checkout", "-q", "-B", branch], dir);
}

/**
 * Run a user-supplied transport command with the blob path exposed as
 * $KIT_MEMORY_BLOB. The command comes ONLY from ~/.kit/sync.toml (a local file
 * the operator owns), never the project tree — so a cloned repo can't inject it.
 * Runs through the default shell so an operator can write `aws s3 cp …` etc.
 */
function runTransportCmd(cmd: string, blobPath: string): void {
  execSync(cmd, {
    env: { ...process.env, KIT_MEMORY_BLOB: blobPath },
    stdio: ["ignore", "inherit", "inherit"],
    timeout: 120_000,
  });
}

export interface PushResult {
  /** Display label for where the blob went (the remote URL, or "command transport"). */
  target: string;
  file: string;
  /** False when the encrypted blob was byte-identical to what's already on the remote (git only). */
  pushed: boolean;
}

/**
 * Encrypt the local memory DB and push it to the private remote. Requires a
 * passphrase (KIT_MEMORY_PASSPHRASE). Clones the remote, refreshes the blob,
 * commits and pushes only when it changed (so a no-op push is free and quiet).
 */
export function pushMemory(cfg: SyncConfig, passphrase: string, projectRoot: string): PushResult {
  const dir = mkdtempSync(join(tmpdir(), "kit-memsync-"));
  try {
    if (cfg.transport === "command") {
      const blob = join(dir, cfg.file);
      backupEncrypted(passphrase, getMemoryDbPath(), blob);
      runTransportCmd(cfg.pushCmd!, blob);
      return { target: "command transport", file: cfg.file, pushed: true };
    }
    // git transport — clone into the (empty) dir FIRST, then write the blob inside it.
    assertRemoteNotProjectOrigin(cfg.remote!, projectRoot);
    cloneOrInit(cfg.remote!, cfg.branch ?? DEFAULT_BRANCH, dir);
    backupEncrypted(passphrase, getMemoryDbPath(), join(dir, cfg.file));
    git(["add", "--", cfg.file], dir);
    const dirty = git(["status", "--porcelain"], dir).trim();
    if (!dirty) return { target: cfg.remote!, file: cfg.file, pushed: false };
    // Identify the commit so a fresh-init repo has an author; rely on the user's
    // git identity, falling back to a neutral one only if git has none configured.
    ensureCommitIdentity(dir);
    git(["commit", "-q", "-m", "kit memory sync", "--", cfg.file], dir);
    git(["push", "-q", "origin", `HEAD:${cfg.branch ?? DEFAULT_BRANCH}`], dir);
    return { target: cfg.remote!, file: cfg.file, pushed: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface PullResult {
  target: string;
  file: string;
  /** False when the store has no blob yet (nothing to merge). */
  found: boolean;
  merge?: MergeResult;
}

/**
 * Fetch the encrypted blob from the configured store and merge it into the local
 * store (last-write-wins via mergeDb). The passphrase decrypts the blob; a raw
 * `.db` blob (unusual for this transport) needs none.
 */
export function pullMemory(
  cfg: SyncConfig,
  passphrase: string | undefined,
  projectRoot: string,
): PullResult {
  const dir = mkdtempSync(join(tmpdir(), "kit-memsync-"));
  try {
    const blob = join(dir, cfg.file);
    let target: string;
    if (cfg.transport === "command") {
      // The pull command must DOWNLOAD the blob to $KIT_MEMORY_BLOB. A command
      // that finds nothing simply leaves the path absent → found:false.
      runTransportCmd(cfg.pullCmd!, blob);
      target = "command transport";
    } else {
      assertRemoteNotProjectOrigin(cfg.remote!, projectRoot);
      cloneOrInit(cfg.remote!, cfg.branch ?? DEFAULT_BRANCH, dir);
      target = cfg.remote!;
    }
    if (!existsSync(blob)) return { target, file: cfg.file, found: false };
    const db = openMemoryDb();
    try {
      const merge = syncFromExport(db, blob, { passphrase });
      return { target, file: cfg.file, found: true, merge };
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Give the throwaway clone a commit identity if the environment has none. */
function ensureCommitIdentity(dir: string): void {
  const has = (key: string): boolean => {
    try {
      return !!git(["config", key], dir).trim();
    } catch {
      return false;
    }
  };
  if (!has("user.email")) git(["config", "user.email", "kit-memory-sync@localhost"], dir);
  if (!has("user.name")) git(["config", "user.name", "kit memory sync"], dir);
}
