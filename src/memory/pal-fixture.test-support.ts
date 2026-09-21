import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import {
  deviceId,
  palClaim,
  palResolve,
  palShow,
  type PendingAction,
  type PalClaimOptions,
} from "./pal.js";

export function withPalDevice<T>(device: string, run: () => T): T {
  const previous = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = device;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
  }
}

/** Construct an owned fixture; tests of stale or competing receipts call palClaim directly. */
export function claimTask(
  db: DatabaseSync,
  id: string,
  session = "fixture",
  harness = "test-harness",
): PalClaimOptions {
  const owner = { device: deviceId({ persist: false }), harness, session };
  const result = palClaim(db, id, {
    owner,
    label: session,
    expectedFrontier: palShow(db, id)!.frontier,
  });
  assert.equal(result.status, "applied");
  return { owner, expectedFrontier: result.view!.frontier, label: session };
}

export function setPalClock(
  db: DatabaseSync,
  id: string,
  timestamps: Partial<Pick<PendingAction, "claimed_at" | "snooze_until">>,
): void {
  const view = palShow(db, id);
  assert.ok(view);
  assert.equal(view.heads.length, 1);
  const owner = view.heads[0].state.claim_owner ?? undefined;
  const set = () =>
    palResolve(db, id, {
      expectedFrontier: view.frontier,
      owner,
      choice: { state: { ...view.heads[0].state, ...timestamps } },
    });
  const result = owner ? withPalDevice(owner.device, set) : set();
  assert.equal(result.status, "applied");
}

/** Reconstruct only the historical display-cache bug, retaining events and SQL guards. */
export function seedPreFixClaimConflict(db: DatabaseSync, id: string): void {
  const view = palShow(db, id)!;
  assert.equal(view.heads.length, 2);
  assert.equal(view.heads[0].state.status, "claimed");
  assert.deepEqual(view.heads[0].state, view.heads[1].state);
  const guard = db.prepare("SELECT sql FROM sqlite_master WHERE name='pal_state_update'").get()!
    .sql;
  db.exec("DROP TRIGGER pal_state_update");
  try {
    db.prepare("UPDATE pending_actions SET state_conflict=0 WHERE id=?").run(id);
  } finally {
    db.exec(String(guard));
  }
}

const legacyColumns = [
  "id",
  "status",
  "title",
  "detail",
  "scope",
  "kind",
  "verify_cmd",
  "verify_check",
  "created_at",
  "next_check",
  "snooze_until",
  "closed_at",
  "verify_passes",
  "origin_device",
  "origin_root",
  "claimed_by",
  "claimed_at",
] as const;
type LegacyAction = Pick<PendingAction, "id" | "title"> &
  Partial<Pick<PendingAction, (typeof legacyColumns)[number]>>;

/** Seed only a new pre-causal store; opening it with openMemoryDb performs the migration. */
export function seedLegacyPalDb(path: string, rows: LegacyAction[]): void {
  assert.equal(existsSync(path), false, "legacy fixtures require a new database path");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE schema_meta (version INTEGER NOT NULL);
      INSERT INTO schema_meta VALUES (10);
      CREATE TABLE pending_actions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open', title TEXT NOT NULL,
        detail TEXT, scope TEXT, kind TEXT NOT NULL DEFAULT 'manual', verify_cmd TEXT,
        verify_check TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, next_check TEXT,
        snooze_until TEXT, closed_at TEXT, verify_passes INTEGER NOT NULL DEFAULT 0,
        origin_device TEXT, origin_root TEXT, claimed_by TEXT, claimed_at TEXT
      );
    `);
    const insert = db.prepare(
      `INSERT INTO pending_actions (${legacyColumns.join(",")})
       VALUES (${legacyColumns.map(() => "?").join(",")})`,
    );
    for (const row of rows) {
      const action = {
        status: "open",
        kind: "manual",
        created_at: "2000-01-01 00:00:00",
        verify_passes: 0,
        ...row,
      };
      insert.run(...legacyColumns.map((column) => action[column] ?? null));
    }
  } finally {
    db.close();
  }
}

export function legacyPalDb(t: TestContext, rows: LegacyAction[]): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "kit-pal-legacy-fixture-"));
  try {
    const path = join(directory, "memory.db");
    seedLegacyPalDb(path, rows);
    const db = openMemoryDb(path);
    t.after(() => {
      if (db.isOpen) db.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return db;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
