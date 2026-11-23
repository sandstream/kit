import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  renameSync,
  type BigIntStats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  privateDirIsControlled,
  privateFileIsControlled,
  secureDirStrict,
  secureFileStrict,
} from "../utils/secure-perms.js";
import { sameIdentity } from "../utils/same-file.js";

export interface RepositoryBinding {
  root: string;
  device: string;
  inode: string;
  birthtime: string;
}

function fail(): never {
  throw new Error("Incoming trust: authority store unavailable");
}

function entry(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

function controlledDirectory(path: string, privateAccess = false): BigIntStats {
  const info = entry(path);
  if (!info?.isDirectory() || !privateDirIsControlled(path)) fail();
  if (privateAccess && process.platform !== "win32" && (info.mode & 0o077n) !== 0n) fail();
  return info;
}

function makeDirectory(path: string): void {
  if (entry(path)) {
    controlledDirectory(path);
    return;
  }
  makeDirectory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
  secureDirStrict(path);
}

/** Resolve absent suffixes without following a linked authority directory. */
function canonicalDirectory(path: string): string {
  const missing: string[] = [];
  let ancestor = path;
  while (!entry(ancestor)) {
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) fail();
    ancestor = parent;
  }
  controlledDirectory(ancestor);
  return join(realpathSync(ancestor), ...missing);
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function bindRepository(repository: string): RepositoryBinding {
  const root = realpathSync(repository);
  const info = entry(root);
  if (!info?.isDirectory() || info.ino === 0n) fail();
  return {
    root,
    device: String(info.dev),
    inode: String(info.ino),
    birthtime: String(info.birthtimeNs),
  };
}

function assertRepository(repository: string, expected: RepositoryBinding): void {
  const actual = bindRepository(repository);
  if (
    actual.root !== expected.root ||
    actual.device !== expected.device ||
    actual.inode !== expected.inode ||
    actual.birthtime !== expected.birthtime
  )
    fail();
}

function location(directory: string, repository: string) {
  if (!isAbsolute(directory) || !isAbsolute(repository)) fail();
  const requestedParent = dirname(resolve(directory));
  if (entry(requestedParent)) controlledDirectory(requestedParent);
  const binding = bindRepository(repository);
  const target = canonicalDirectory(resolve(directory));
  if (contains(binding.root, target) || contains(target, binding.root)) {
    throw new Error("Incoming trust: authority store must be outside the repository");
  }
  return { directory: target, binding };
}

function verifyRollbackHeader(path: string, info: BigIntStats): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameIdentity(info, fstatSync(fd, { bigint: true }))) fail();
    const header = Buffer.alloc(100);
    // SQLite fileformat.html: bytes 18 and 19 are 1 for rollback, 2 for WAL.
    // Inspect before SQLite opens the file: read-only WAL opens can create sidecars.
    if (
      readSync(fd, header, 0, header.length, 0) !== header.length ||
      header.subarray(0, 16).toString("ascii") !== "SQLite format 3\0" ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      fail();
  } finally {
    closeSync(fd);
  }
}

function databaseFile(path: string, create: boolean) {
  let created = false;
  if (!entry(path) && create) {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    closeSync(fd);
    secureFileStrict(path);
    created = true;
  }
  const info = entry(path);
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1n || info.ino === 0n || info.size > 64n * 1024n * 1024n)
    fail();
  if (!privateFileIsControlled(path)) fail();
  if (process.platform !== "win32" && (info.mode & 0o077n) !== 0n) fail();
  if (!created) verifyRollbackHeader(path, info);
  return { info, created };
}

function schema(db: DatabaseSync, create: boolean): void {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (version === 1) return;
  if (version !== 0 || !create || db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get()) fail();
  db.exec(`CREATE TABLE incoming (
    root TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL UNIQUE,
    device TEXT NOT NULL,
    inode TEXT NOT NULL,
    birthtime TEXT NOT NULL,
    body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 1048576)
  ) STRICT;
  PRAGMA user_version = 1`);
}

function assertLocations(
  path: string,
  file: BigIntStats,
  directory: BigIntStats,
  parent: BigIntStats,
): void {
  if (
    !sameIdentity(file, entry(path)) ||
    !sameIdentity(directory, entry(dirname(path))) ||
    !sameIdentity(parent, entry(dirname(dirname(path))))
  )
    fail();
}

/** Trusted parent directories and host code remain prerequisites. This is not same-account containment. */
export function withIncomingDatabase<T>(
  directory: string,
  repository: string,
  mode: "read" | "enroll" | "update" | "lock",
  operation: (db: DatabaseSync, binding: RepositoryBinding, recheck: () => void) => T,
): T | null {
  const target = location(directory, repository);
  const write = mode !== "read";
  const create = mode === "enroll";
  if (!entry(target.directory) && !create) return null;
  if (create) makeDirectory(target.directory);
  const parent = controlledDirectory(dirname(target.directory));
  const dir = controlledDirectory(target.directory, true);
  const path = join(target.directory, "authority.sqlite");
  // SQLite also discovers WAL through sidecars when the main header says rollback.
  if (entry(`${path}-wal`) || entry(`${path}-shm`)) fail();
  const file = databaseFile(path, create);
  if (!file) return null;
  const db = new DatabaseSync(path, { readOnly: !write });
  let transaction = false;
  try {
    assertLocations(path, file.info, dir, parent);
    db.exec("PRAGMA busy_timeout = 5000");
    if (write) {
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
      assertLocations(path, file.info, dir, parent);
    }
    if (mode === "lock") assertRepository(repository, target.binding);
    schema(db, file.created);
    const recheck = () => {
      assertLocations(path, file.info, dir, parent);
      if (mode === "lock") assertRepository(repository, target.binding);
    };
    const result = operation(db, target.binding, recheck);
    recheck();
    if (write) {
      db.exec("COMMIT");
      transaction = false;
    }
    return result;
  } finally {
    try {
      if (transaction) db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
}

export const QUARANTINE_ACKNOWLEDGEMENT = "move-damaged-authority-store-aside";

/**
 * Move a damaged database and its sidecars aside under a new name. Nothing is deleted or
 * rewritten. The caller says whether the store is still readable; a readable store is refused.
 * The database file is shared by every repository in the directory, so all of them need a new
 * enrollment afterwards.
 */
export function quarantineDatabase(
  directory: string,
  repository: string,
  isReadable: () => boolean,
): string {
  const target = location(directory, repository);
  if (!entry(target.directory)) throw new Error("Incoming trust: not-damaged");
  controlledDirectory(dirname(target.directory));
  const dir = controlledDirectory(target.directory, true);
  const path = join(target.directory, "authority.sqlite");
  const info = entry(path);
  if (!info) throw new Error("Incoming trust: not-damaged");
  if (!info.isFile() || !privateFileIsControlled(path)) fail();
  if (isReadable()) throw new Error("Incoming trust: not-damaged");
  if (!sameIdentity(info, entry(path)) || !sameIdentity(dir, entry(target.directory))) fail();
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
  const destination = `${path}.damaged-${stamp}-${randomBytes(4).toString("hex")}`;
  if (entry(destination)) fail();
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = entry(`${path}${suffix}`);
    if (sidecar && !sidecar.isFile()) fail();
  }
  renameSync(path, destination);
  for (const suffix of ["-wal", "-shm"]) {
    if (entry(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${destination}${suffix}`);
  }
  return destination;
}
