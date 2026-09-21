import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertSupportedMemorySchema } from "./db-schema.js";

function enableWal(db: DatabaseSync): void {
  const deadline = performance.now() + 5000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
    db.exec(`PRAGMA busy_timeout = ${remaining}`);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      break;
    } catch (error) {
      const code = (error as { errcode?: number })?.errcode;
      const wait = deadline - performance.now();
      if (typeof code !== "number" || (code & 0xff) !== 5 || wait <= 0) throw error;
      // SQLite can skip its busy handler during a journal lock upgrade. Only this
      // idempotent PRAGMA is retried, within one budget; migration writes are not.
      Atomics.wait(sleeper, 0, 0, Math.min(10, wait));
    }
  }
  db.exec("PRAGMA busy_timeout = 5000");
}

/** Return a migrated connection; failed startup rolls back and closes it. */
export function openMigratedDb(path: string, migrate: (db: DatabaseSync) => void): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    assertSupportedMemorySchema(db);
    enableWal(db);
    db.exec("PRAGMA foreign_keys = OFF");
    // Acquire the writer before inspecting columns, backfilling, or reading the
    // schema version. A concurrent opener must observe the committed migration.
    db.exec("BEGIN IMMEDIATE");
    assertSupportedMemorySchema(db);
    migrate(db);
    db.exec("COMMIT");
    return db;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // WAL setup/BEGIN can fail before a transaction exists; keep the cause.
    }
    try {
      db.close();
    } catch {
      // Cleanup must not mask the initialization failure.
    }
    throw error;
  }
}

/** Read-only WAL opens can need sidecars. Retry immutable only when both are absent. */
export function openReadOnlyDb(path: string): DatabaseSync {
  if (path === ":memory:") return new DatabaseSync(path);
  let db = new DatabaseSync(path, { readOnly: true });
  try {
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
  } catch (err) {
    try {
      db.close();
    } catch {
      /* best-effort close */
    }
    const sidecarsMissing = !existsSync(`${path}-wal`) && !existsSync(`${path}-shm`);
    if (!sidecarsMissing) throw err;
    const uri = pathToFileURL(path);
    uri.searchParams.set("mode", "ro");
    uri.searchParams.set("immutable", "1");
    db = new DatabaseSync(uri.href);
  }
  try {
    assertSupportedMemorySchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
