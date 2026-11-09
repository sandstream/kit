import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { sameIdentity } from "./utils/same-file.js";

const LOCK_FILE = ".kit-budget-lock.sqlite";
const LOCK_ERROR = "Could not lock budget usage. Check .kit-budget-lock.sqlite.";
const LOCK_TIMEOUT = "Timed out waiting for the budget lock after 5000 ms.";
const WAIT_MS = 5000;
const localLocks = new Set<string>();

function assertRegularFile(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error(LOCK_ERROR);
}

function assertSameFile(path: string, expected: BigIntStats): void {
  const actual = lstatSync(path, { bigint: true });
  assertRegularFile(actual);
  if (!sameIdentity(actual, expected)) throw new Error(LOCK_ERROR);
}

function validateFile(path: string): BigIntStats {
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (before) assertRegularFile(before);
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const descriptor = openSync(path, flags, 0o600);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    assertRegularFile(stat);
    if (before && !sameIdentity(before, stat)) throw new Error(LOCK_ERROR);
    assertSameFile(path, stat);
    return stat;
  } finally {
    // Close before SQLite starts its transaction. POSIX close can release its locks.
    closeSync(descriptor);
  }
}

function openDatabase(path: string): { database: DatabaseSync; stat: BigIntStats } {
  let database: DatabaseSync | undefined;
  try {
    const stat = validateFile(path);
    database = new DatabaseSync(path);
    database.exec("PRAGMA busy_timeout = 0");
    assertSameFile(path, stat);
    return { database, stat };
  } catch {
    if (database) closeDatabase(database, false);
    // Do not expose filesystem paths, SQLite messages, or their error causes.
    throw new Error(LOCK_ERROR);
  }
}

function isLockError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const sqlite = error as { code?: string; errcode?: number };
  if (sqlite.code !== "ERR_SQLITE_ERROR" || typeof sqlite.errcode !== "number") return false;
  // The low byte also recognizes SQLite's extended BUSY and LOCKED result codes.
  const primaryCode = sqlite.errcode & 0xff;
  return primaryCode === 5 || primaryCode === 6;
}

async function waitForRetry(deadline: number): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error(LOCK_TIMEOUT);
  await delay(Math.min(20, remaining));
  if (performance.now() >= deadline) throw new Error(LOCK_TIMEOUT);
}

async function acquireTransaction(database: DatabaseSync, deadline: number): Promise<void> {
  for (;;) {
    if (performance.now() >= deadline) throw new Error(LOCK_TIMEOUT);
    try {
      database.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!isLockError(error)) {
        // eslint-disable-next-line preserve-caught-error -- SQLite diagnostics can expose paths.
        throw new Error(LOCK_ERROR);
      }
    }
    await waitForRetry(deadline);
  }
}

function commitTransaction(database: DatabaseSync): void {
  try {
    database.exec("COMMIT");
  } catch {
    throw new Error(LOCK_ERROR);
  }
}

function closeDatabase(database: DatabaseSync, committed: boolean): void {
  if (!committed) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // No active transaction, or rollback failed. Closing still releases the lock.
    }
  }
  try {
    database.close();
  } catch {
    // Preserve the callback or acquisition exception when cleanup also fails.
    if (committed) throw new Error(LOCK_ERROR);
  }
}

function lockPath(cwd: string): string {
  try {
    // Directory aliases must share the local gate, before any file descriptor opens.
    return join(realpathSync(cwd), LOCK_FILE);
  } catch {
    throw new Error(LOCK_ERROR);
  }
}

/**
 * Serialize a short budget read-modify-write. Never run the user operation here.
 * The five-second deadline covers acquisition, not the callback. Calls are not reentrant.
 * SQLite releases its OS lock on process exit. Keep the database inode on release.
 *
 * Use a local filesystem with working SQLite locks and trusted parent directories.
 * O_NOFOLLOW protects the validation open. Check file type, link count, and inode again
 * after SQLite opens the path and after acquisition. DatabaseSync cannot open our descriptor.
 * SQLite does not expose its descriptor for an identity check.
 * These checks cannot prevent an adversary from replacing parent directories or swapping
 * paths between checks, including SQLite journal paths. They cannot secure such directories.
 * Other code must not replace, unlink, or directly open and close this database during use.
 * The local gate protects calls through this module instance, not separate worker instances.
 * SQLite protects independent processes. A crash does not undo writes made by the callback.
 */
export async function withBudgetLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + WAIT_MS;
  const path = lockPath(cwd);
  // A raw validation descriptor must not close while this process holds a SQLite lock.
  while (localLocks.has(path)) await waitForRetry(deadline);
  localLocks.add(path);
  let database: DatabaseSync | undefined;
  let committed = false;
  try {
    const opened = openDatabase(path);
    database = opened.database;
    await acquireTransaction(database, deadline);
    try {
      assertSameFile(path, opened.stat);
    } catch {
      throw new Error(LOCK_ERROR);
    }
    const value = await operation();
    commitTransaction(database);
    committed = true;
    return value;
  } finally {
    try {
      if (database) closeDatabase(database, committed);
    } finally {
      localLocks.delete(path);
    }
  }
}
