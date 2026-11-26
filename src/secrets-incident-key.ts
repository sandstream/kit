/**
 * The HMAC key behind `kit secrets incident` fingerprints, kept OUT of the repo tree.
 *
 * kit-research#232 follow-up, owner direction "trust no one": a snapshot that carries its own
 * key lets anyone who reads it (a leaked tree, a backup, a synced folder) test guesses for a
 * value. The key therefore lives per user, per project, per backend:
 *
 *   ~/.kit/incident-keys/<project-id>/<backend>.key   (owner-only, regular file, one link)
 *
 * and the snapshot keeps only a key id (a domain-separated SHA-256 of the key). The key file is
 * created only when a snapshot is taken; reading it never creates, repairs or replaces it. Every
 * problem (missing, symlinked, widened, malformed, inside the repo, wrong id, no project id) is
 * an {@link IncidentKeyError} the caller turns into a refusal.
 *
 * Not the OS keystore: `src/keystore` is an Ed25519 signing port (sign/publicKeyPem), not a
 * store for secret bytes, and its hardware backends are stubs. Adding a blob store there is a
 * separate decision; until then this file under ~/.kit is the same posture as
 * `~/.kit/audit-anchor.key` and `~/.kit/elevation.key`.
 *
 * Project id: kit has no per-project user-state id on disk. `[memory].project_id` is checked in,
 * so the repo's own content would choose it and every clone would share one key directory. The
 * id here is a hash of the repo root's native realpath, case-folded where the filesystem usually
 * is (Windows, macOS), so the same checkout always maps to the same directory.
 */
import { constants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";
import {
  privateDirIsControlled,
  privateFileIsControlled,
  secureDirStrict,
  secureFileStrictAsync,
} from "./utils/secure-perms.js";

export const INCIDENT_KEY_BYTES = 32;
const MAX_KEY_FILE_BYTES = 4096n;

export class IncidentKeyError extends Error {}

/** `~/.kit/incident-keys`: per-user, outside every project. */
export function defaultIncidentKeyRoot(home: string = homedir()): string {
  return join(home, ".kit", "incident-keys");
}

/** Public, non-secret id of a key: never the key, never reversible to it. */
export function incidentKeyId(key: Buffer): string {
  return (
    "ik_" +
    createHash("sha256").update("kit-incident-key-id/v1\0").update(key).digest("hex").slice(0, 32)
  );
}

/** The spelling two paths to the same checkout share on this OS. Pure. */
export function canonicalProjectRoot(
  nativeRealpath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return nativeRealpath.replaceAll("\\", "/").toLowerCase();
  if (platform === "darwin") return nativeRealpath.normalize("NFC").toLowerCase();
  return nativeRealpath;
}

export function projectIdFromRoot(
  nativeRealpath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return createHash("sha256")
    .update("kit-incident-project/v1\0")
    .update(canonicalProjectRoot(nativeRealpath, platform), "utf8")
    .digest("hex")
    .slice(0, 32);
}

export interface IncidentProject {
  /** Native realpath of the repo root (git toplevel, or cwd outside a work tree). */
  root: string;
  id: string;
}

/** Resolve the project root and its id. Throws when either cannot be determined. */
export async function resolveIncidentProject(cwd: string): Promise<IncidentProject> {
  const top = await execFileNoThrow("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    timeout: 5_000,
  });
  const candidate = top.ok && top.stdout.trim() ? top.stdout.trim() : cwd;
  let root: string;
  try {
    root = realpathSync.native(candidate);
  } catch (error) {
    throw new IncidentKeyError(`cannot determine the project id (${candidate} does not resolve)`, {
      cause: error,
    });
  }
  if (!identityOf(root)?.isDirectory()) {
    throw new IncidentKeyError(`cannot determine the project id (${root} is not a directory)`);
  }
  return { root, id: projectIdFromRoot(root) };
}

export function incidentKeyPath(keyRoot: string, projectId: string, backend: string): string {
  if (!/^[0-9a-f]{32}$/.test(projectId) || !/^[a-z0-9][a-z0-9-]*$/.test(backend)) {
    throw new IncidentKeyError("invalid project id or backend name for an incident key path");
  }
  return join(keyRoot, projectId, `${backend}.key`);
}

/** Nearest ancestor of `path` (itself included) that exists, as a native realpath. */
function nearestExisting(path: string): string {
  let current = path;
  for (;;) {
    try {
      return realpathSync.native(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * True when `path` lies in or below `root`. Compared by bigint file identity on every existing
 * ancestor, so case, 8.3 names, `/tmp` vs `/private/tmp` and symlinked parents cannot hide it.
 */
export function isInsideTree(path: string, root: string): boolean {
  const target = identityOf(root);
  if (!target) return false;
  let current = nearestExisting(path);
  const top = parse(current).root;
  for (;;) {
    if (sameIdentity(identityOf(current), target)) return true;
    if (current === top) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function assertOutsideRepo(path: string, project: IncidentProject): void {
  if (isInsideTree(path, project.root)) {
    throw new IncidentKeyError(
      `incident key location ${path} is inside the project; it must live outside the repo tree`,
    );
  }
}

/** The two kit-owned directories under the key root: real directories, owner-controlled. */
function assertKeyDirs(path: string, keyRoot: string): void {
  for (const dir of [keyRoot, dirname(path)]) {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st) continue;
    if (!st.isDirectory()) {
      throw new IncidentKeyError(`${dir} is not a real directory (symlink or file); refusing`);
    }
    if (!privateDirIsControlled(dir)) {
      throw new IncidentKeyError(`${dir} is writable by other users; refusing`);
    }
  }
}

function keyFileIsOwnerOnly(info: BigIntStats, path: string): boolean {
  if (process.platform === "win32") return privateFileIsControlled(path);
  const uid = process.getuid?.();
  return (info.mode & 0o077n) === 0n && (uid === undefined || info.uid === BigInt(uid));
}

async function checkedKeyFile(handle: FileHandle, path: string): Promise<BigIntStats> {
  const info = await handle.stat({ bigint: true });
  const entry = await lstat(path, { bigint: true });
  if (entry.isSymbolicLink()) throw new IncidentKeyError(`incident key ${path} is a symlink`);
  if (!info.isFile() || !entry.isFile() || !sameIdentity(info, entry) || info.nlink !== 1n) {
    throw new IncidentKeyError(`incident key ${path} is not a single-link regular file`);
  }
  if (!keyFileIsOwnerOnly(info, path)) {
    throw new IncidentKeyError(`incident key ${path} is not owner-only (permissions widened)`);
  }
  if (info.size > MAX_KEY_FILE_BYTES)
    throw new IncidentKeyError(`incident key ${path} is malformed`);
  return info;
}

async function openKeyFile(path: string): Promise<FileHandle> {
  const link = lstatSync(path, { throwIfNoEntry: false });
  if (!link) throw new IncidentKeyError(`incident key missing: ${path}`);
  if (link.isSymbolicLink()) throw new IncidentKeyError(`incident key ${path} is a symlink`);
  try {
    return await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new IncidentKeyError(`cannot safely open incident key ${path}`, { cause: error });
  }
}

/**
 * Read the key for one project and backend. Never creates or repairs it: every problem throws
 * an {@link IncidentKeyError}.
 */
export async function readIncidentKey(
  keyRoot: string,
  project: IncidentProject,
  backend: string,
): Promise<Buffer> {
  const path = incidentKeyPath(keyRoot, project.id, backend);
  assertOutsideRepo(path, project);
  assertKeyDirs(path, keyRoot);
  const handle = await openKeyFile(path);
  try {
    const before = await checkedKeyFile(handle, path);
    const hex = (await handle.readFile("utf8")).trim();
    const after = await checkedKeyFile(handle, path);
    if (after.size !== before.size || !/^[0-9a-f]{64}$/.test(hex)) {
      throw new IncidentKeyError(`incident key ${path} is malformed`);
    }
    return Buffer.from(hex, "hex");
  } finally {
    await handle.close();
  }
}

async function ensureKeyDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new IncidentKeyError(`${dir} is not a real directory; refusing`);
  secureDirStrict(dir);
}

/**
 * Create a fresh key for one project and backend and return it. `replace` false refuses when a
 * key already exists (only `--new-snapshot` re-keys). A non-regular entry at the key path is
 * never replaced: it is left for a person to inspect.
 */
export async function createIncidentKey(
  keyRoot: string,
  project: IncidentProject,
  backend: string,
  replace: boolean,
): Promise<Buffer> {
  const path = incidentKeyPath(keyRoot, project.id, backend);
  assertOutsideRepo(path, project);
  assertKeyDirs(path, keyRoot);
  const existing = lstatSync(path, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) {
    throw new IncidentKeyError(`${path} exists and is not a regular file; inspect it, refusing`);
  }
  if (existing && !replace) {
    throw new IncidentKeyError(
      `an incident key already exists at ${path}; re-key with --new-snapshot`,
    );
  }
  await ensureKeyDir(keyRoot);
  await ensureKeyDir(dirname(path));
  assertOutsideRepo(path, project);
  const key = randomBytes(INCIDENT_KEY_BYTES);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    await secureFileStrictAsync(tmp);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return key;
}
