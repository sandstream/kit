import { lstatSync, type BigIntStats } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { sameIdentity } from "./utils/same-file.js";

const WAIT_MS = 5000;
const localLocks = new Set<string>();

function regularFile(path: string): BigIntStats | undefined {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1n)) {
    throw new Error("The coordination file must be a regular file with one link.");
  }
  return stat;
}

function assertIdentity(path: string, expected: BigIntStats): void {
  const actual = regularFile(path);
  if (!sameIdentity(actual, expected)) {
    throw new Error("The coordination file changed during lock acquisition.");
  }
}

function openDatabase(path: string): { database: DatabaseSync; stat: BigIntStats } {
  const before = regularFile(path);
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    const stat = regularFile(path);
    if (!stat) throw new Error("The coordination file disappeared.");
    if (before) assertIdentity(path, before);
    return { database, stat };
  } catch (error) {
    database.close();
    throw error;
  }
}

function busy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const sqlite = error as { code?: string; errcode?: number };
  if (sqlite.code !== "ERR_SQLITE_ERROR" || typeof sqlite.errcode !== "number") return false;
  return [5, 6].includes(sqlite.errcode & 0xff);
}

async function wait(deadline: number): Promise<void> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error("Timed out waiting for the audit lock after 5000 ms.");
  await delay(Math.min(20, remaining));
}

async function acquire(database: DatabaseSync, deadline: number): Promise<void> {
  for (;;) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for the audit lock after 5000 ms.");
    }
    try {
      database.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!busy(error)) throw error;
    }
    await wait(deadline);
  }
}

/**
 * Hold a SQLite OS lock across a short asynchronous file update.
 * Use a canonical path on a local filesystem with trusted parent directories.
 * Never unlink or replace the coordination file. Process exit releases its lock.
 * Callback writes are not part of the SQLite transaction and cannot be rolled back.
 * Do not open raw validation descriptors: closing one can release another SQLite lock.
 * Path checks reject ordinary substitution, but cannot secure hostile parent directories.
 */
export async function withSqliteMutex<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + WAIT_MS;
  while (localLocks.has(path)) await wait(deadline);
  localLocks.add(path);
  let database: DatabaseSync | undefined;
  try {
    const opened = openDatabase(path);
    database = opened.database;
    await acquire(database, deadline);
    assertIdentity(path, opened.stat);
    return await operation();
  } finally {
    try {
      // No database data changes. Closing rolls back and releases the OS lock.
      database?.close();
    } finally {
      localLocks.delete(path);
    }
  }
}
