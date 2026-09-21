import assert from "node:assert/strict";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import {
  palAdd,
  palConfigure,
  palSnooze,
  palDone,
  palShow,
  palResolve,
  type VerifyCheck,
} from "./pal.js";
import { claimTask } from "./pal-fixture.test-support.js";

function fixture(t: TestContext) {
  const previous = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "pal-configure-fixture";
  const db = openMemoryDb(":memory:");
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
  });
  const id = palAdd(db, { title: "explicit check", scope: "/original-project" });
  const row = () => db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id)!;
  return { db, id, row };
}

for (const state of ["open", "claimed", "snoozed", "closed"]) {
  it(`verifier replacement preserves ${state} lifecycle and immutable or recall identity`, (t) => {
    const { db, id, row } = fixture(t);
    const claim =
      state === "claimed" ? claimTask(db, id, "configure-session", "claude") : undefined;
    if (state === "snoozed") palSnooze(db, id, 7);
    if (state === "closed") palDone(db, id);
    const view = palShow(db, id)!;
    assert.equal(
      palResolve(db, id, {
        expectedFrontier: view.frontier,
        owner: claim?.owner,
        choice: { state: { ...view.heads[0].state, next_check: "2030-01-01" } },
      }).status,
      "applied",
    );
    db.prepare(
      `UPDATE pending_actions SET recall_scope = '/local-project', recall_device = 'local-device',
       import_state = 'source-fingerprint', verify_passes = 1 WHERE id = ?`,
    ).run(id);
    const before = row();
    assert.equal(palConfigure(db, id, { type: "file-exists", path: "artifact" }), true);
    const grant = row().verify_grant;
    assert.match(String(grant), /^[a-f0-9]{32}$/);
    assert.notEqual(grant, before.verify_grant);
    assert.deepEqual(
      { ...row() },
      {
        ...before,
        kind: "auto",
        verify_grant: grant,
        verify_passes: 0,
        verify_definition: JSON.stringify({
          type: "file-exists",
          path: join(process.cwd(), "artifact"),
        }),
      },
    );
    assert.equal(palConfigure(db, id, null), true);
    assert.deepEqual(
      { ...row() },
      { ...before, kind: "manual", verify_passes: 0, verify_definition: null, verify_grant: null },
    );
  });
}

it("verifier configuration accepts HTTP status boundaries and rejects malformed targets", (t) => {
  const { db, id, row } = fixture(t);
  for (const expect of [100, 200, 599]) {
    const check: VerifyCheck = { type: "http-status", url: "https://example.com/", expect };
    assert.equal(palConfigure(db, id, check), true);
    assert.equal(row().verify_definition, JSON.stringify(check));
    assert.equal(row().verify_check, null, "legacy verifier slot stays inert");
  }
  const before = row();
  const invalid: VerifyCheck[] = [
    { type: "file-exists", path: "" },
    { type: "file-exists", path: "bad\0path" },
    { type: "http-status", url: "not a URL", expect: 200 },
    { type: "http-status", url: "file:///tmp/artifact", expect: 200 },
    ...[0, 99, 600, 200.5, NaN, Infinity].map((expect) => ({
      type: "http-status" as const,
      url: "https://example.com/",
      expect,
    })),
  ];
  for (const check of invalid) {
    assert.throws(() => palConfigure(db, id, check), RangeError);
    assert.deepEqual(row(), before);
  }
  assert.equal(palConfigure(db, "missing", null), false);
});
