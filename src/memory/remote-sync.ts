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
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
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
  // opt-in automation (off by default) — wired into the SessionStart/SessionEnd hooks.
  /** Pull + merge the store at the start of each session. */
  pullOnStart?: boolean;
  /** Index + push the store at the end of each session (key for ephemeral containers). */
  pushOnEnd?: boolean;
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

  const bool = (v: unknown): boolean => v === true;
  const pullOnStart = bool(s.pull_on_start);
  const pushOnEnd = bool(s.push_on_end);

  const transport: SyncTransport = s.transport === "command" ? "command" : "git";
  if (transport === "command") {
    const pushCmd = str(s.push_cmd);
    const pullCmd = str(s.pull_cmd);
    if (!pushCmd || !pullCmd) {
      throw new Error('[memory.sync] transport = "command" requires both push_cmd and pull_cmd');
    }
    return { transport, file, pushCmd, pullCmd, pullOnStart, pushOnEnd };
  }

  const remote = str(s.remote);
  if (!remote) return null; // git transport with no remote → treat as unconfigured
  const branch = str(s.branch) || DEFAULT_BRANCH;
  assertSafeGitRef(remote, "remote");
  assertSafeGitRef(branch, "branch");
  return { transport, file, remote, branch, pullOnStart, pushOnEnd };
}

/**
 * Reject a git remote/branch value that git would treat as something other than a
 * plain operand. These reach git as positional argv (execFileSync — no shell, so
 * OS metacharacters are already inert), but two git-level vectors remain:
 *   - a value starting with '-' is parsed as an OPTION, e.g. a "remote" of
 *     `--upload-pack=<cmd>` turns `git clone` into arbitrary command execution;
 *   - `ext::`/`fd::` remote helpers run a command by design (`git clone ext::sh -c …`).
 * Config is operator-owned (~/.kit/sync.toml, never the repo tree), so this is
 * defense-in-depth — but it also future-proofs any `sync init` that ingests a
 * remote from a less-trusted source. Call sites additionally pass
 * `--end-of-options` and disable the ext/fd protocols.
 */
function assertSafeGitRef(value: string, what: "remote" | "branch"): void {
  if (value.startsWith("-")) {
    throw new Error(`invalid [memory.sync] ${what} "${value}" — must not start with '-'`);
  }
  if (what === "remote" && /^(ext|fd)::/i.test(value)) {
    throw new Error(
      `invalid [memory.sync] remote "${value}" — ext::/fd:: remote helpers are not allowed`,
    );
  }
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
  // Disable the command-running remote helpers unconditionally (harmless for the
  // local ops too) so even a value that slipped past validation can't reach the
  // ext::/fd:: handlers.
  return execFileSync(
    "git",
    ["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

/**
 * Get a working clone of the remote on the configured branch into `dir`. If the
 * remote/branch doesn't exist yet (first push), fall back to a fresh repo wired to
 * the remote so the initial push creates the branch.
 */
function cloneOrInit(remote: string, branch: string, dir: string): void {
  try {
    // --end-of-options: everything after is a positional operand, so a remote/branch
    // can never be reinterpreted as a git option (belt-and-suspenders to assertSafeGitRef).
    git(["clone", "--depth", "1", "--branch", branch, "--end-of-options", remote, "."], dir);
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
  // Do NOT hand the transport our secrets. It only moves the already-encrypted
  // blob, so it never needs KIT_MEMORY_PASSPHRASE — and a command that logs its
  // environment (`aws --debug`, a shell with `set -x`, an error tracer) would
  // otherwise spill the passphrase that protects the blob right next to the blob,
  // collapsing the encryption guarantee. Strip every kit-managed secret from the
  // child env; the operator's own provider credentials (AWS_*, etc.) pass through.
  const env: Record<string, string | undefined> = { ...process.env, KIT_MEMORY_BLOB: blobPath };
  for (const k of Object.keys(env)) {
    if (/^KIT_.*(PASSPHRASE|SECRET|TOKEN|PASSWORD|KEY)$/.test(k)) delete env[k];
  }
  execSync(cmd, {
    env: env as NodeJS.ProcessEnv,
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

export interface InitSyncOptions {
  transport?: SyncTransport;
  remote?: string;
  branch?: string;
  pushCmd?: string;
  pullCmd?: string;
  /** Enable pull-on-start + push-on-end. */
  auto?: boolean;
  /** Overwrite an existing sync.toml. */
  force?: boolean;
}

/**
 * Write a starter `~/.kit/sync.toml` (LOCAL, never committed). Returns created:false
 * (without touching the file) when one already exists and `force` isn't set.
 */
export function initSyncConfig(opts: InitSyncOptions = {}): { path: string; created: boolean } {
  const path = getSyncConfigPath();
  if (existsSync(path) && !opts.force) return { path, created: false };
  const transport: SyncTransport = opts.transport ?? "git";
  const lines = ["[memory.sync]"];
  if (transport === "command") {
    lines.push('transport = "command"');
    lines.push(
      `push_cmd = ${JSON.stringify(opts.pushCmd ?? 'aws s3 cp "$KIT_MEMORY_BLOB" s3://YOUR-BUCKET/kit-memory.enc')}`,
    );
    lines.push(
      `pull_cmd = ${JSON.stringify(opts.pullCmd ?? 'aws s3 cp s3://YOUR-BUCKET/kit-memory.enc "$KIT_MEMORY_BLOB"')}`,
    );
  } else {
    lines.push(
      `remote = ${JSON.stringify(opts.remote ?? "git@github.com:YOU/your-private-memory.git")}`,
    );
    if (opts.branch) lines.push(`branch = ${JSON.stringify(opts.branch)}`);
  }
  if (opts.auto) {
    lines.push("pull_on_start = true");
    lines.push("push_on_end = true");
  }
  mkdirSync(getMemoryDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
  return { path, created: true };
}

export interface AutoSyncResult {
  ran: boolean;
  /** A short human note for stderr (a sync happened, or why it was skipped). */
  note?: string;
}

/**
 * Pull + merge at session start when `[memory.sync] pull_on_start = true`. Always
 * fail-soft: a missing config, missing passphrase, or transport error never throws
 * (a session must never be blocked by sync). No-op unless the flag is set.
 */
export function tryAutoPull(projectRoot: string): AutoSyncResult {
  let cfg: SyncConfig | null;
  try {
    cfg = loadSyncConfig();
  } catch {
    return { ran: false };
  }
  if (!cfg || !cfg.pullOnStart) return { ran: false };
  try {
    const r = pullMemory(cfg, process.env.KIT_MEMORY_PASSPHRASE, projectRoot);
    return { ran: true, note: r.found ? `memory synced from ${r.target}` : undefined };
  } catch (e) {
    return { ran: false, note: `memory pull skipped: ${(e as Error).message}` };
  }
}

/**
 * True iff `[memory.sync] push_on_end = true`. Cheap, fail-safe (false on any
 * error). The SessionEnd hook uses this to decide whether the index must run
 * inline — so the push includes this session — or can be detached for a fast,
 * never-cancelled exit on the common (no-push) path.
 */
export function isAutoPushConfigured(): boolean {
  try {
    return loadSyncConfig()?.pushOnEnd === true;
  } catch {
    return false;
  }
}

/**
 * Index-and-push at session end when `[memory.sync] push_on_end = true`. The key
 * piece for EPHEMERAL containers: the session's memory reaches your durable store
 * before the container is reclaimed. Fail-soft; needs KIT_MEMORY_PASSPHRASE.
 */
export function tryAutoPush(projectRoot: string): AutoSyncResult {
  let cfg: SyncConfig | null;
  try {
    cfg = loadSyncConfig();
  } catch {
    return { ran: false };
  }
  if (!cfg || !cfg.pushOnEnd) return { ran: false };
  if (!process.env.KIT_MEMORY_PASSPHRASE) {
    return { ran: false, note: "memory push skipped: KIT_MEMORY_PASSPHRASE not set" };
  }
  try {
    const r = pushMemory(cfg, process.env.KIT_MEMORY_PASSPHRASE, projectRoot);
    return { ran: true, note: r.pushed ? `memory pushed to ${r.target}` : undefined };
  } catch (e) {
    return { ran: false, note: `memory push skipped: ${(e as Error).message}` };
  }
}

const NUDGE_MARKER = ".sync-nudge-shown";

/**
 * One-time upgrade nudge: if sync is NOT configured but there's a memory store
 * worth syncing, suggest `kit memory sync init` — once (a marker under ~/.kit
 * suppresses it thereafter). Returns null when nothing should be shown.
 */
export function maybeSyncNudge(): string | null {
  try {
    if (loadSyncConfig()) return null; // already configured
  } catch {
    return null;
  }
  const marker = join(getMemoryDir(), NUDGE_MARKER);
  if (existsSync(marker)) return null;
  let worthIt = false;
  try {
    const p = getMemoryDbPath();
    worthIt = existsSync(p) && statSync(p).size > 64 * 1024; // a non-trivial store
  } catch {
    worthIt = false;
  }
  if (!worthIt) return null;
  try {
    writeFileSync(marker, "", { mode: 0o600 });
  } catch {
    /* best-effort — if we can't write the marker, worst case we nudge again */
  }
  return "tip: sync your memory across machines (and back it up) — run `kit memory sync init`";
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
