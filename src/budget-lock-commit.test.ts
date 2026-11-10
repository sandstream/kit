/**
 * SQLite initializes a new database inside its first write transaction, so that COMMIT needs
 * an exclusive lock. A contender that is between its shared and reserved lock refuses it with
 * SQLITE_BUSY, and the transaction stays open. On the Windows CI runner four processes hit this
 * on first creation: the callback had run, and the lock still reported a failure.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { withBudgetLock } from "./budget-lock.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

const LOCK_FILE = ".kit-budget-lock.sqlite";

function holdSharedLock(cwd: string): DatabaseSync {
  const reader = new DatabaseSync(join(cwd, LOCK_FILE));
  reader.exec("PRAGMA busy_timeout = 0");
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM sqlite_master").get();
  return reader;
}

test("commit outlasts a contender that briefly holds a shared lock on a new database", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "kit-budget-lock-commit-"));
  t.after(() => rmTemp(cwd));
  let ran = 0;
  const value = await withBudgetLock(cwd, async () => {
    ran++;
    const reader = holdSharedLock(cwd);
    setTimeout(() => {
      reader.exec("ROLLBACK");
      reader.close();
    }, 150);
    return 7;
  });
  assert.equal(value, 7);
  assert.equal(ran, 1);
  // The lock is released: the next caller acquires at once.
  assert.equal(await withBudgetLock(cwd, async () => 8), 8);
});

test("commit gives up with the lock error when the contender never leaves", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "kit-budget-lock-commit-"));
  let reader: DatabaseSync | undefined;
  t.after(() => {
    reader?.close();
    rmTemp(cwd);
  });
  await assert.rejects(
    withBudgetLock(cwd, async () => {
      reader = holdSharedLock(cwd);
    }),
    /Could not lock budget usage/,
  );
});
