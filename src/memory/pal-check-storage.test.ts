import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import { palAdd, palAutoVerify, palList } from "./pal.js";
import { palAutoVerify as legacyVerify } from "./pal-legacy.test-support.js";
import { fixture as filesFixture } from "./backup.test-support.js";

function fixture(t: TestContext) {
  const files = filesFixture(t);
  const previous = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "check-migration-fixture";
  t.after(() => {
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
  });
  return files;
}

function legacyLayout(db: DatabaseSync): void {
  db.exec(`DROP TRIGGER pending_check_legacy_insert;
    DROP TRIGGER pending_check_legacy_update;
    UPDATE pending_actions SET verify_check = verify_definition;
    ALTER TABLE pending_actions DROP COLUMN verify_definition;
    UPDATE schema_meta SET version=13`);
}

for (const approved of [true, false]) {
  it(`same-file legacy migration preserves history and ${approved ? "retains" : "does not invent"} local approval`, async (t) => {
    const { src, track } = fixture(t);
    const source = openMemoryDb(src);
    let id: string;
    let before: ReturnType<typeof palList>;
    try {
      id = palAdd(source, { title: "migration state", check: { type: "file-exists", path: src } });
      if (!approved) source.exec("UPDATE pending_actions SET verify_grant=NULL");
      before = palList(source, { readOnly: true });
      legacyLayout(source);
    } finally {
      source.close();
    }
    const migrated = track(openMemoryDb(src));
    assert.deepEqual(palList(migrated, { readOnly: true }), before);
    assert.equal((await legacyVerify(migrated, 1)).checked, 0);
    const result = await palAutoVerify(migrated, 1);
    if (approved) assert.deepEqual(result.closed, [id]);
    else {
      assert.equal(result.unverified[0]?.reason, "no-local-approval");
      assert.deepEqual(palList(migrated, { readOnly: true }), before);
    }
    assert.equal(
      migrated.prepare("SELECT verify_check FROM pending_actions").get()?.verify_check,
      null,
    );
  });
}

it("conflicting stored definitions refuse migration without discarding either value", (t) => {
  const { src, track } = fixture(t);
  const source = openMemoryDb(src);
  let before: Record<string, unknown>[];
  try {
    palAdd(source, { title: "conflicting definitions", check: { type: "file-exists", path: src } });
    source.exec(`DROP TRIGGER pending_check_legacy_insert;
      DROP TRIGGER pending_check_legacy_update;
      UPDATE pending_actions SET verify_check='legacy alternative';
      UPDATE schema_meta SET version=13`);
    before = source.prepare("SELECT * FROM pending_actions").all();
  } finally {
    source.close();
  }
  assert.throws(() => openMemoryDb(src), /Conflicting legacy and current verification definitions/);
  const preserved = track(new DatabaseSync(src, { readOnly: true }));
  assert.deepEqual(preserved.prepare("SELECT * FROM pending_actions").all(), before);
  assert.equal(preserved.prepare("SELECT version FROM schema_meta").get()?.version, 13);
});
