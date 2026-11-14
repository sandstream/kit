import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { storeFixture } from "./authority-store.test-support.js";
import { QUARANTINE_ACKNOWLEDGEMENT } from "./authority-files.js";

function enrolled(f: ReturnType<typeof storeFixture>): string {
  f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
  return join(f.directory, "authority.sqlite");
}

it("moves a damaged database aside only on explicit acknowledgement, then allows enrollment", () => {
  const f = storeFixture();
  try {
    const path = enrolled(f);
    truncateSync(path, 0);
    assert.throws(() => f.store.read(f.repository));
    assert.throws(() => f.store.quarantineDamaged(f.repository, "yes" as never));
    assert.equal(existsSync(path), true, "wrong acknowledgement must not move anything");
    const result = f.store.quarantineDamaged(f.repository, QUARANTINE_ACKNOWLEDGEMENT);
    assert.equal(existsSync(path), false);
    assert.equal(readFileSync(result.quarantinedTo).length, 0, "evidence moved, not rewritten");
    assert.match(result.quarantinedTo, /authority\.sqlite\.damaged-/);
    assert.equal(f.store.read(f.repository), null);
    const state = f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    assert.equal(state.phase, "pending");
  } finally {
    f.cleanup();
  }
});

it("refuses to quarantine a healthy store, so recovery cannot discard an approval", () => {
  const f = storeFixture();
  try {
    const path = enrolled(f);
    const before = readFileSync(path);
    assert.throws(
      () => f.store.quarantineDamaged(f.repository, QUARANTINE_ACKNOWLEDGEMENT),
      /not-damaged/,
    );
    assert.deepEqual(readFileSync(path), before);
    assert.equal(f.store.read(f.repository)?.phase, "pending");
  } finally {
    f.cleanup();
  }
});

it("refuses when no store exists", () => {
  const f = storeFixture();
  try {
    assert.throws(
      () => f.store.quarantineDamaged(f.repository, QUARANTINE_ACKNOWLEDGEMENT),
      /not-damaged/,
    );
  } finally {
    f.cleanup();
  }
});

it("moves sidecar files with the database and never overwrites earlier evidence", () => {
  const f = storeFixture();
  try {
    const path = enrolled(f);
    truncateSync(path, 0);
    writeFileSync(`${path}-wal`, "wal");
    const first = f.store.quarantineDamaged(f.repository, QUARANTINE_ACKNOWLEDGEMENT);
    enrolled(f);
    truncateSync(path, 0);
    const second = f.store.quarantineDamaged(f.repository, QUARANTINE_ACKNOWLEDGEMENT);
    assert.notEqual(first.quarantinedTo, second.quarantinedTo);
    assert.equal(readFileSync(`${first.quarantinedTo}-wal`, "utf8"), "wal");
    const names = readdirSync(f.directory);
    assert.equal(names.filter((n) => n.startsWith("authority.sqlite.damaged-")).length, 3);
    assert.equal(names.includes("authority.sqlite-wal"), false);
  } finally {
    f.cleanup();
  }
});

it("is refused in read-only mode", () => {
  const f = storeFixture();
  const previous = process.env.KIT_READ_ONLY;
  try {
    const path = enrolled(f);
    truncateSync(path, 0);
    process.env.KIT_READ_ONLY = "1";
    assert.throws(
      () => f.store.quarantineDamaged(f.repository, QUARANTINE_ACKNOWLEDGEMENT),
      /read-only/,
    );
    assert.equal(existsSync(path), true);
  } finally {
    if (previous === undefined) delete process.env.KIT_READ_ONLY;
    else process.env.KIT_READ_ONLY = previous;
    f.cleanup();
  }
});
