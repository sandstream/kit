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
  palSyncFindings,
  findingPalId,
} from "./pal.js";

describe("PAL — pending actions", () => {
  const fresh = () => openMemoryDb(":memory:");

  it("adds + lists; kind inferred from a verify check", () => {
    const db = fresh();
    const manual = palAdd(db, { title: "ship the harvest branch" });
    const auto = palAdd(db, {
      title: "endpoint returns 200",
      check: { type: "http-status", url: "https://example.com", expect: 200 },
    });
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

  it("auto-verify closes after N=2 passes; a failing check stays open", async () => {
    const db = fresh();
    const tmp = mkdtempSync(join(tmpdir(), "kit-pal-"));
    const present = join(tmp, "present");
    writeFileSync(present, "x");
    const missing = join(tmp, "missing");
    const passes = palAdd(db, {
      title: "passing check",
      check: { type: "file-exists", path: present },
    });
    const fails = palAdd(db, {
      title: "failing check",
      check: { type: "file-exists", path: missing },
    });
    let r = await palAutoVerify(db);
    assert.deepEqual(r.closed, []); // first pass: streak = 1
    assert.equal(palList(db).length, 2);
    r = await palAutoVerify(db);
    assert.deepEqual(r.closed, [passes]); // second consecutive pass closes it
    const open = palList(db);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.id, fails);
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  it("reopens a closed auto item when its check regresses", async () => {
    const db = fresh();
    const tmp = mkdtempSync(join(tmpdir(), "kit-pal-"));
    const artifact = join(tmp, "artifact");
    writeFileSync(artifact, "x");
    const id = palAdd(db, {
      title: "regressing check",
      check: { type: "file-exists", path: artifact },
    });
    palDone(db, id); // force-close
    assert.equal(palList(db, { status: "closed" }).length, 1);
    rmSync(artifact); // artifact gone -> the check now fails
    const r = await palAutoVerify(db); // fail on a closed auto item -> reopen
    assert.deepEqual(r.reopened, [id]);
    assert.equal(palList(db).length, 1);
    rmSync(tmp, { recursive: true, force: true });
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
        JSON.stringify({
          id: "bbbb",
          ts: "2026-06-02",
          status: "done",
          repo: "app-b",
          title: "cert fixed",
        }),
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

  it("SECURITY: a verify command imported from a legacy ledger is never auto-executed", async () => {
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
    await palAutoVerify(db); // must NOT run `touch ${marker}`
    assert.equal(existsSync(marker), false, "imported verify_cmd must never execute");
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  it("SECURITY: an unknown/injected verify_check shape is never executed", async () => {
    const db = fresh();
    const tmp = mkdtempSync(join(tmpdir(), "kit-pal-sec2-"));
    const marker = join(tmp, "PWNED");
    // Simulate DB tampering: inject a row with a bogus verify_check that a naive
    // executor might run as a command. parseCheck must reject the unknown shape;
    // nothing executes.
    db.prepare(
      `INSERT INTO pending_actions (id, status, title, kind, verify_check)
       VALUES ('evil', 'open', 'injected', 'auto', ?)`,
    ).run(JSON.stringify({ type: "shell", cmd: `touch ${marker}` }));
    const r = await palAutoVerify(db);
    assert.equal(r.checked, 0); // unknown shape -> not even run
    assert.equal(existsSync(marker), false, "injected verify_check must never execute");
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

describe("palSyncFindings — findings → ledger (track layer)", () => {
  const fresh = () => openMemoryDb(":memory:");
  const f = (dedupKey: string, title = dedupKey) => ({ dedupKey, title });

  it("findingPalId is deterministic + source-prefixed", () => {
    assert.equal(findingPalId("sec", "dep:npm audit"), findingPalId("sec", "dep:npm audit"));
    assert.ok(findingPalId("sec", "x").startsWith("sec-"));
    assert.notEqual(findingPalId("sec", "x"), findingPalId("secret", "x"));
  });

  it("is idempotent — re-syncing the same findings adds no duplicates", () => {
    const db = fresh();
    assert.equal(palSyncFindings(db, "sec", [f("a"), f("b")], { scope: "repo" }).added, 2);
    assert.equal(palSyncFindings(db, "sec", [f("a"), f("b")], { scope: "repo" }).added, 0);
    assert.equal(palList(db, { scope: "repo" }).length, 2);
    db.close();
  });

  it("auto-closes a finding the scan no longer reports", () => {
    const db = fresh();
    palSyncFindings(db, "sec", [f("a"), f("b")], { scope: "repo" });
    const r = palSyncFindings(db, "sec", [f("a")], { scope: "repo" });
    assert.equal(r.closed.length, 1);
    const open = palList(db, { scope: "repo" });
    assert.equal(open.length, 1);
    assert.ok(open[0]?.id.startsWith("sec-"));
    db.close();
  });

  it("reopens a finding that cleared and then regressed", () => {
    const db = fresh();
    palSyncFindings(db, "sec", [f("a")], { scope: "repo" });
    palSyncFindings(db, "sec", [], { scope: "repo" }); // clears → closed
    assert.equal(palList(db, { scope: "repo" }).length, 0);
    const r = palSyncFindings(db, "sec", [f("a")], { scope: "repo" }); // regress
    assert.equal(r.reopened, 1);
    assert.equal(palList(db, { scope: "repo" }).length, 1);
    db.close();
  });

  it("reconciles only its own source tag (sec vs secret isolated)", () => {
    const db = fresh();
    palSyncFindings(db, "sec", [f("a")], { scope: "repo" });
    palSyncFindings(db, "secret", [f("x")], { scope: "repo" });
    const r = palSyncFindings(db, "secret", [], { scope: "repo" }); // clears only secret-*
    assert.equal(r.closed.length, 1);
    const open = palList(db, { scope: "repo" });
    assert.equal(open.length, 1);
    assert.ok(open[0]?.id.startsWith("sec-"));
    db.close();
  });
});
