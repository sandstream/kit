import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import { palAdd, palAutoVerify, palConfigure, palDone, palList, palShow } from "./pal.js";
import { legacyPalDb } from "./pal-fixture.test-support.js";

function fixture(t: TestContext) {
  const previousCwd = process.cwd();
  const previousDevice = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "pal-path-fixture";
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-pal-verify-path-")));
  const A = join(root, "A");
  const B = join(root, "B");
  mkdirSync(A);
  mkdirSync(B);
  const db = openMemoryDb(":memory:");
  t.after(() => {
    process.chdir(previousCwd);
    if (previousDevice === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previousDevice;
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, A, B };
}

it("a relative verifier cannot close project A's work using project B's file", async (t) => {
  const { db, A, B } = fixture(t);
  process.chdir(A);
  const id = palAdd(db, {
    title: "project A artifact",
    check: { type: "file-exists", path: "artifact" },
  });
  writeFileSync(join(B, "artifact"), "belongs to project B");
  process.chdir(B);
  const result = await palAutoVerify(db, 1);
  assert.deepEqual(result.closed, []);
  assert.equal(palList(db, { readOnly: true })[0]?.id, id);
});

it("a relative check still finds its creation project's artifact from another cwd", async (t) => {
  const { db, A, B } = fixture(t);
  process.chdir(A);
  writeFileSync(join(A, "artifact"), "project A artifact");
  const id = palAdd(db, {
    title: "project A artifact",
    scope: B,
    check: { type: "file-exists", path: "artifact" },
  });
  db.prepare("UPDATE pending_actions SET recall_scope = ? WHERE id = ?").run(B, id);
  process.chdir(B);
  assert.deepEqual((await palAutoVerify(db, 1)).closed, [id]);
});

it("a locally configured absolute check works from another cwd without inventing a legacy origin", async (t) => {
  const { A, B } = fixture(t);
  const artifact = join(A, "artifact");
  writeFileSync(artifact, "explicit absolute target");
  const id = "absolute";
  const db = legacyPalDb(t, [
    {
      id,
      title: "absolute target",
      kind: "auto",
      verify_check: JSON.stringify({ type: "file-exists", path: artifact }),
      origin_root: null,
    },
  ]);
  const before = palShow(db, id, { history: true });
  const unapproved = await palAutoVerify(db, 1);
  assert.equal(unapproved.checked, 0);
  assert.deepEqual(unapproved.closed, []);
  assert.deepEqual(
    unapproved.unverified.map(({ id, reason }) => ({ id, reason })),
    [{ id, reason: "no-local-approval" }],
  );
  assert.equal(palConfigure(db, id, { type: "file-exists", path: artifact }), true);
  assert.deepEqual(palShow(db, id, { history: true }), before);
  process.chdir(B);
  assert.deepEqual((await palAutoVerify(db, 1)).closed, [id]);
  assert.equal(palShow(db, id)?.origin.root, null);
});

it("an unbound legacy relative check is reported without inferring a root from scope", async (t) => {
  const { A, B } = fixture(t);
  process.chdir(A);
  const id = "relative";
  const db = legacyPalDb(t, [
    {
      id,
      title: "legacy relative target",
      kind: "auto",
      scope: B,
      verify_check: JSON.stringify({ type: "file-exists", path: "artifact" }),
      origin_root: null,
    },
  ]);
  db.prepare("UPDATE pending_actions SET recall_scope = ? WHERE id = ?").run(B, id);
  writeFileSync(join(B, "artifact"), "must not count");
  process.chdir(B);
  const before = palList(db, { readOnly: true });
  const result = await palAutoVerify(db, 1);
  assert.deepEqual(result.closed, []);
  assert.equal(result.checked, 0);
  assert.deepEqual(
    result.unverified.map(({ id, reason }) => ({ id, reason })),
    [{ id, reason: "unbound-path" }],
  );
  assert.deepEqual(palList(db, { readOnly: true }), before);
});

it("a missing creation directory is not evidence that closed work regressed", async (t) => {
  const { db, A, B } = fixture(t);
  process.chdir(A);
  const id = palAdd(db, {
    title: "lost workspace",
    check: { type: "file-exists", path: "artifact" },
  });
  palDone(db, id);
  process.chdir(B);
  rmSync(A, { recursive: true });
  const before = palList(db, { readOnly: true, status: "closed" });
  const result = await palAutoVerify(db);
  assert.deepEqual(result.reopened, []);
  assert.equal(result.checked, 0);
  assert.deepEqual(
    result.unverified.map(({ id, reason }) => ({ id, reason })),
    [{ id, reason: "unavailable-origin" }],
  );
  assert.deepEqual(palList(db, { readOnly: true, status: "closed" }), before);
});
