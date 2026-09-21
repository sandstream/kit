import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function hasSqliteHeader(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    return readSync(fd, header, 0, 16, 0) === 16 && header.toString() === "SQLite format 3\0";
  } finally {
    closeSync(fd);
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const relation = db
    .prepare("PRAGMA table_list")
    .all()
    .find((row) => row.schema === "main" && String(row.name).toLowerCase() === name);
  if (relation && relation.type !== "table")
    throw new Error("Unverifiable task deletion data; use kit memory sync instead of raw restore");
  return !!relation;
}

/** Raw restore keeps bytes unchanged, but cannot roll back known task deletion records. */
export function assertActionDeletionsPreserved(staged: string, destination: string): void {
  if (!hasSqliteHeader(destination)) return;
  const directory = mkdtempSync(join(tmpdir(), "kit-pal-recovery-"));
  let local: DatabaseSync | undefined;
  let incoming: DatabaseSync | undefined;
  try {
    // Even read-only SQLite opens may create WAL/SHM files. Inspect owned bytes,
    // never open or clean auxiliary files alongside the recovery destination.
    chmodSync(directory, 0o700);
    const snapshot = join(directory, "destination.db");
    copyFileSync(destination, snapshot);
    chmodSync(snapshot, 0o600);
    local = new DatabaseSync(snapshot, { readOnly: true });
    if (!tableExists(local, "pal_tombstones")) return;
    const deleted = local.prepare("SELECT sync_id FROM pal_tombstones").all();
    if (!deleted.length) return;
    incoming = new DatabaseSync(staged, { readOnly: true });
    if (!tableExists(incoming, "pal_tombstones"))
      throw new Error("Restore would discard task deletion records; use kit memory sync instead");
    const tombstone = incoming.prepare("SELECT 1 FROM pal_tombstones WHERE sync_id=?");
    const projections = tableExists(incoming, "pending_actions")
      ? incoming.prepare("SELECT 1 FROM pending_actions WHERE sync_id=?")
      : null;
    const history = tableExists(incoming, "pal_revisions")
      ? incoming.prepare("SELECT 1 FROM pal_revisions WHERE sync_id=?")
      : null;
    for (const row of deleted) {
      if (
        typeof row.sync_id !== "string" ||
        !tombstone.get(row.sync_id) ||
        projections?.get(row.sync_id) ||
        history?.get(row.sync_id)
      )
        throw new Error("Restore would undo a task deletion; use kit memory sync instead");
    }
  } finally {
    incoming?.close();
    local?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
