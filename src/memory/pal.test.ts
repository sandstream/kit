import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb } from "./db.js";
import {
  palAdd,
  palList,
  palDone,
  palSnooze,
  palAutoVerify,
  importLegacyLedger,
} from "./pal.js";

describe("PAL — pending actions", () => {
  const fresh = () => openMemoryDb(":memory:");

  it("adds + lists; kind inferred from verifyCmd", () => {
    const db = fresh();
    const manual = palAdd(db, { title: "ship the harvest branch" });
    const auto = palAdd(db, { title: "endpoint returns 200", verifyCmd: "true" });
    assert.match(manual, /^[0-9a-f]{4}$/);
    const open = palList(db);
    assert.equal(open.length, 2);
    assert.equal(open.find((p) => p.id === manual)?.kind, "manual");
    assert.equal(open.find((p) => p.id === auto)?.kind, "auto");
    db.close();
  });

  it("done closes; closed leaves the open list", () => {
    const db = fresh();
    const id = palAdd(db, { title: "x" });
    assert.equal(palDone(db, id), true);
    assert.equal(palList(db).length, 0);
    assert.equal(palList(db, { status: "closed" }).length, 1);
    assert.equal(palDone(db, id), false); // already closed
    db.close();
  });

  it("snooze moves an item out of the open list", () => {
    const db = fresh();
    const id = palAdd(db, { title: "later" });
    assert.equal(palSnooze(db, id, 7), true);
    assert.equal(palList(db).length, 0);
    assert.equal(palList(db, { status: "snoozed" }).length, 1);
    db.close();
  });

  it("auto-verify closes after N=2 passes; a failing verify stays open", () => {
    const db = fresh();
    const passes = palAdd(db, { title: "passing check", verifyCmd: "true" });
    const fails = palAdd(db, { title: "failing check", verifyCmd: "false" });
    let r = palAutoVerify(db);
    assert.deepEqual(r.closed, []); // first pass: streak = 1
    assert.equal(palList(db).length, 2);
    r = palAutoVerify(db);
    assert.deepEqual(r.closed, [passes]); // second consecutive pass closes it
    const open = palList(db);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.id, fails);
    db.close();
  });

  it("reopens a closed auto item when its verify regresses", () => {
    const db = fresh();
    const id = palAdd(db, { title: "regressing check", verifyCmd: "false" });
    palDone(db, id); // force-close
    assert.equal(palList(db, { status: "closed" }).length, 1);
    const r = palAutoVerify(db); // verify 'false' on a closed auto item → reopen
    assert.deepEqual(r.reopened, [id]);
    assert.equal(palList(db).length, 1);
    db.close();
  });

  it("imports the legacy python PAL ledger, mapping fields (idempotent)", () => {
    const db = fresh();
    const tmp = mkdtempSync(join(tmpdir(), "kit-pal-"));
    const led = join(tmp, "ledger.jsonl");
    writeFileSync(
      led,
      [
        JSON.stringify({
          id: "aaaa",
          ts: "2026-06-01",
          status: "open",
          repo: "app-a",
          title: "ship thing",
          why: "branch not merged",
          verify: "false",
          pass_streak: 1,
        }),
        JSON.stringify({ id: "bbbb", ts: "2026-06-02", status: "done", repo: "app-b", title: "cert fixed" }),
      ].join("\n"),
    );
    const r = importLegacyLedger(db, led);
    assert.equal(r.imported, 2);
    const open = palList(db);
    const a = open.find((p) => p.id === "aaaa");
    // SECURITY: a `verify` command from a file is never imported as an
    // auto-executing command. The item is demoted to `manual` with no verify_cmd.
    assert.equal(a?.kind, "manual");
    assert.equal(a?.verify_cmd ?? null, null);
    assert.equal(a?.scope, "app-a"); // repo → scope
    assert.equal(a?.detail, "branch not merged"); // why → detail
    assert.equal(a?.verify_passes, 1); // pass_streak → verify_passes
    assert.equal(
      palList(db, { status: "closed" }).find((p) => p.id === "bbbb")?.title,
      "cert fixed",
    ); // done → closed
    assert.equal(importLegacyLedger(db, led).imported, 0); // idempotent
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  it("SECURITY: a verify command imported from a legacy ledger is never auto-executed", () => {
    const db = fresh();
    const tmp = mkdtempSync(join(tmpdir(), "kit-pal-sec-"));
    const led = join(tmp, "ledger.jsonl");
    const marker = join(tmp, "PWNED");
    writeFileSync(
      led,
      JSON.stringify({
        id: "evil",
        ts: "2026-06-01",
        status: "open",
        title: "attacker-controlled entry",
        verify: `touch ${marker}`, // would run if imported as auto + auto-verified
      }) + "\n",
    );
    importLegacyLedger(db, led);
    const item = palList(db).find((p) => p.id === "evil");
    assert.equal(item?.kind, "manual"); // demoted: not an auto item
    assert.equal(item?.verify_cmd ?? null, null); // executable command dropped on import
    palAutoVerify(db); // must NOT run `touch ${marker}`
    assert.equal(existsSync(marker), false, "imported verify_cmd must never execute");
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  it("scopes the open list to a project (plus globally-scoped items)", () => {
    const db = fresh();
    palAdd(db, { title: "kit item", scope: "kit" });
    palAdd(db, { title: "other item", scope: "other" });
    palAdd(db, { title: "global item" }); // no scope
    assert.equal(palList(db).length, 3); // no scope filter = every project
    const scoped = palList(db, { scope: "kit" });
    assert.deepEqual(
      scoped.map((p) => p.title).sort(),
      ["global item", "kit item"], // "kit" + the null-scope global one, NOT "other"
    );
    db.close();
  });
});
