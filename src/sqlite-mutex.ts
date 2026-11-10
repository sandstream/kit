import { lstatSync, type BigIntStats } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { sameIdentity } from "./utils/same-file.js";

const WAIT_MS = 5000;
const MAX_WAIT_MS = 120_000;

/**
 * How long one caller waits for the lock. The default is 5 s. `KIT_AUDIT_LOCK_WAIT_MS` may only
 * RAISE it (to at most two minutes): several writers queue behind one lock, and on a slow disk
 * the last of them can need longer than 5 s for the writers ahead of it to finish. Measured on
 * GitHub's Windows runners, where 8 processes × 2 appends and 12 seals in one process both timed
 * out. A value below the default, or not a whole number, is ignored, so the variable cannot be
 * used to make audit appends fail sooner.
 */
export function lockWaitMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.KIT_AUDIT_LOCK_WAIT_MS?.trim() ?? "";
  if (!/^\d{1,9}$/.test(raw)) return WAIT_MS;
  return Math.min(Math.max(Number(raw), WAIT_MS), MAX_WAIT_MS);
}

function timedOut(waitMs: number): Error {
  return new Error(`Timed out waiting for the audit lock after ${waitMs} ms.`);
}
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

/** One caller's wait: when it ends, and the budget it was given (for the message). */
interface Budget {
  deadline: number;
  waitMs: number;
}

async function wait(budget: Budget): Promise<void> {
  const remaining = budget.deadline - performance.now();
  if (remaining <= 0) throw timedOut(budget.waitMs);
  await delay(Math.min(20, remaining));
}

async function acquire(database: DatabaseSync, budget: Budget): Promise<void> {
  for (;;) {
    if (performance.now() >= budget.deadline) throw timedOut(budget.waitMs);
    try {
      database.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!busy(error)) throw error;
    }
    await wait(budget);
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
  const waitMs = lockWaitMs();
  const budget: Budget = { deadline: performance.now() + waitMs, waitMs };
  while (localLocks.has(path)) await wait(budget);
  localLocks.add(path);
  let database: DatabaseSync | undefined;
  try {
    const opened = openDatabase(path);
    database = opened.database;
    await acquire(database, budget);
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
