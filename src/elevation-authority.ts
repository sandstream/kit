import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  privateDirIsControlled,
  privateFileIsControlled,
  secureDirStrict,
  secureFileStrict,
} from "./utils/secure-perms.js";
import { sameIdentity } from "./utils/same-file.js";

const UNAVAILABLE = "Elevation authority is unavailable; fresh confirmation is required";

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Restrict the directory only when this call created it. An existing one is checked by the caller. */
function createDirectory(directory: string): void {
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    return;
  }
  secureDirStrict(directory);
}

function createStore(path: string): void {
  try {
    closeSync(openSync(path, "wx", 0o600));
    secureFileStrict(path);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
}

function inTransaction<T>(db: DatabaseSync, operation: (db: DatabaseSync) => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS grants (
      project TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1))
    )`);
    const result = operation(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Keep one current grant per project outside the project writable boundary.
 * SQLite transactions serialize issuance, revocation, and consumption across processes.
 * Parent directories must be trusted, as with the machine's signing key.
 */
function withAuthority<T>(write: boolean, operation: (db: DatabaseSync) => T): T {
  const directory = join(homedir(), ".kit", "elevation-authority");
  const path = join(directory, "grants.sqlite");
  if (write) createDirectory(directory);
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || !privateDirIsControlled(directory)) throw new Error(UNAVAILABLE);
  if (write) createStore(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || !privateFileIsControlled(path)) {
    throw new Error(UNAVAILABLE);
  }
  const db = new DatabaseSync(path, { readOnly: !write });
  try {
    if (!sameIdentity(before, lstatSync(path, { bigint: true }))) throw new Error(UNAVAILABLE);
    db.exec("PRAGMA busy_timeout = 5000");
    return write ? inTransaction(db, operation) : operation(db);
  } finally {
    db.close();
  }
}

export function elevationGrantIsActive(project: string, id: string): boolean {
  return withAuthority(false, (db) =>
    Boolean(
      db
        .prepare("SELECT 1 FROM grants WHERE project = ? AND id = ? AND active = 1")
        .get(project, id),
    ),
  );
}

export function publishElevationGrant(project: string, id: string, publish: () => void): void {
  withAuthority(true, (db) => {
    db.prepare(
      `INSERT INTO grants (project, id, active) VALUES (?, ?, 1)
      ON CONFLICT(project) DO UPDATE SET id = excluded.id, active = 1`,
    ).run(project, id);
    publish();
  });
}

export function consumeElevationGrant(
  grant: { projectDirectory: string; grantId: string; expiresAt: string },
  remove: () => void,
): boolean {
  return withAuthority(true, (db) => {
    // Waiting for another writer must not extend the signed approval lifetime.
    if (!(Date.parse(grant.expiresAt) >= Date.now())) return false;
    const result = db
      .prepare("UPDATE grants SET active = 0 WHERE project = ? AND id = ? AND active = 1")
      .run(grant.projectDirectory, grant.grantId);
    if (result.changes !== 1) return false;
    remove();
    return true;
  });
}

export function revokeElevationGrant(project: string, remove: () => void): void {
  withAuthority(true, (db) => {
    db.prepare("UPDATE grants SET active = 0 WHERE project = ?").run(project);
    remove();
  });
}
