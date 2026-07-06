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
  palClaim,
  palRelease,
  reapStaleClaims,
  palAutoVerify,
  palPrune,
  deviceId,
  deviceIdOverrideActive,
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

  it("claim atomically takes an open item; a concurrent second claim loses", () => {
    const db = fresh();
    const id = palAdd(db, { title: "flip the auth setting" });
    assert.equal(palClaim(db, id, "agent-a"), true); // first caller wins
    assert.equal(palClaim(db, id, "agent-b"), false); // WHERE status='open' guard: no double-claim
    assert.equal(palList(db).length, 0); // a claimed item drops out of the open list
    const claimed = palList(db, { status: "claimed" });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.claimed_by, "agent-a");
    db.close();
  });

  it("claim defaults claimed_by to this device", () => {
    const db = fresh();
    const id = palAdd(db, { title: "x" });
    assert.equal(palClaim(db, id), true);
    assert.equal(palList(db, { status: "claimed" })[0]?.claimed_by, deviceId());
    db.close();
  });

  it("release returns a claimed item to open (and only a claimed one)", () => {
    const db = fresh();
    const id = palAdd(db, { title: "x" });
    assert.equal(palRelease(db, id), false); // nothing to release — still open
    palClaim(db, id, "agent-a");
    assert.equal(palRelease(db, id), true);
    const open = palList(db);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.claimed_by, null); // claim cleared
    db.close();
  });

  it("reaps a stale claim (crashed claimer) back to open; a fresh claim is spared", () => {
    const db = fresh();
    const id = palAdd(db, { title: "finish the migration" });
    palClaim(db, id, "agent-a");
    assert.deepEqual(reapStaleClaims(db), [], "a just-made claim is NOT reaped");
    assert.equal(palList(db, { status: "claimed" }).length, 1);
    // Backdate the claim past the TTL → abandoned.
    db.prepare("UPDATE pending_actions SET claimed_at=datetime('now','-30 hours') WHERE id=?").run(
      id,
    );
    assert.deepEqual(reapStaleClaims(db), [id]);
    const claimed = db
      .prepare("SELECT status, claimed_by FROM pending_actions WHERE id=?")
      .get(id) as { status: string; claimed_by: string | null };
    assert.equal(claimed.status, "open");
    assert.equal(claimed.claimed_by, null);
    db.close();
  });

  it("palList auto-reaps a stale claim so a crashed agent can't hide a blocked item", () => {
    const db = fresh();
    const id = palAdd(db, { title: "unblock me" });
    palClaim(db, id, "agent-a");
    assert.equal(palList(db).length, 0, "fresh claim stays hidden");
    db.prepare("UPDATE pending_actions SET claimed_at=datetime('now','-48 hours') WHERE id=?").run(
      id,
    );
    const open = palList(db); // reap runs inside palList
    assert.equal(open.length, 1, "the abandoned item resurfaces as open");
    assert.equal(open[0]?.id, id);
    db.close();
  });

  it("a claimed item can still be marked done by its claimer", () => {
    const db = fresh();
    const id = palAdd(db, { title: "x" });
    palClaim(db, id, "agent-a");
    assert.equal(palDone(db, id), true);
    assert.equal(palList(db, { status: "closed" }).length, 1);
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

  // Regression: the adversarial pass found that the auto-close was device-blind.
  // Because the finding id is identical across machines on a shared store, a scan
  // on device B that doesn't see device A's finding would permanently close A's
  // open security blocker.
  const withDevice = <T>(id: string, fn: () => T): T => {
    const prev = process.env.KIT_DEVICE_ID;
    process.env.KIT_DEVICE_ID = id;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.KIT_DEVICE_ID;
      else process.env.KIT_DEVICE_ID = prev;
    }
  };

  it("a scan on device B does NOT auto-close device A's open finding (shared store)", () => {
    const db = fresh();
    withDevice("dev-A", () => palSyncFindings(db, "sec", [f("leak")], { scope: "repo" }));
    // device B runs a scan of something else (empty for this source+scope)
    const r = withDevice("dev-B", () => palSyncFindings(db, "sec", [], { scope: "repo" }));
    assert.equal(r.closed.length, 0, "B must not close A's finding");
    const all = palList(db, { scope: "repo", allDevices: true });
    assert.equal(all.length, 1, "A's finding is still open");
    assert.equal(all[0]?.origin_device, "dev-A");
    // and A's own re-scan that no longer sees it CAN close it
    const ra = withDevice("dev-A", () => palSyncFindings(db, "sec", [], { scope: "repo" }));
    assert.equal(ra.closed.length, 1, "the owning device reconciles its own finding");
    db.close();
  });

  it("the same finding in two different repos maps to two distinct rows", () => {
    const db = fresh();
    palSyncFindings(db, "sec", [f("leak")], { scope: "/abs/repo-x" });
    palSyncFindings(db, "sec", [f("leak")], { scope: "/abs/repo-y" });
    const all = palList(db, { allDevices: true });
    assert.equal(all.length, 2, "scope is folded into the id — no cross-repo collision");
    assert.notEqual(all[0]?.id, all[1]?.id);
  });

  it("legacy NULL-origin findings are reconcilable by any device", () => {
    const db = fresh();
    // simulate a pre-v5 open finding row (no origin_device) at this scope+id
    const legacyId = findingPalId("sec", "repo\x1fold");
    db.prepare(
      "INSERT INTO pending_actions (id, status, title, scope, kind, origin_device) VALUES (?, 'open', 'old', 'repo', 'finding', NULL)",
    ).run(legacyId);
    const r = withDevice("whoever", () => palSyncFindings(db, "sec", [], { scope: "repo" }));
    assert.equal(r.closed.length, 1, "a NULL-origin legacy finding can be cleared by any device");
    db.close();
  });
});

describe("PAL — device coupling (don't nag about ephemeral-session items)", () => {
  const fresh = () => openMemoryDb(":memory:");
  const withDevice = <T>(id: string, fn: () => T): T => {
    const prev = process.env.KIT_DEVICE_ID;
    process.env.KIT_DEVICE_ID = id;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.KIT_DEVICE_ID;
      else process.env.KIT_DEVICE_ID = prev;
    }
  };

  it("palAdd stamps origin_device + origin_root", () => {
    const db = fresh();
    withDevice("dev-A", () => {
      const id = palAdd(db, { title: "x" });
      const row = palList(db).find((p) => p.id === id)!;
      assert.equal(row.origin_device, "dev-A");
      assert.equal(row.origin_root, process.cwd());
    });
    db.close();
  });

  it("another device's items don't surface by default; --all shows them", () => {
    const db = fresh();
    const a = withDevice("dev-A", () => palAdd(db, { title: "made on A" }));
    const b = withDevice("dev-B", () => palAdd(db, { title: "made on B" }));
    withDevice("dev-B", () => {
      const def = palList(db).map((p) => p.id);
      assert.deepEqual(def, [b], "only THIS device's item surfaces");
      assert.ok(!def.includes(a), "device A's item is hidden");
      const all = palList(db, { allDevices: true })
        .map((p) => p.id)
        .sort();
      assert.deepEqual(all, [a, b].sort(), "--all shows every device");
    });
    db.close();
  });

  it("legacy rows with NULL origin_device always surface (back-compat)", () => {
    const db = fresh();
    db.prepare(
      "INSERT INTO pending_actions (id, status, title, kind, origin_device) VALUES ('leg', 'open', 'legacy', 'manual', NULL)",
    ).run();
    withDevice("any-device", () => {
      assert.ok(palList(db).some((p) => p.id === "leg"));
    });
    db.close();
  });

  it("prune closes this device's dead-origin items, keeps live ones, ignores other devices", () => {
    const db = fresh();
    const live = mkdtempSync(join(tmpdir(), "kit-pal-live-"));
    const dead = join(tmpdir(), "kit-pal-dead-does-not-exist-zzz");
    assert.ok(!existsSync(dead));
    const ins = (id: string, dev: string, root: string) =>
      db
        .prepare(
          "INSERT INTO pending_actions (id, status, title, kind, origin_device, origin_root) VALUES (?, 'open', ?, 'manual', ?, ?)",
        )
        .run(id, id, dev, root);
    withDevice("dev-here", () => {
      ins("dead", "dev-here", dead); // this device, gone dir → pruned
      ins("live", "dev-here", live); // this device, dir exists → kept
      ins("other", "other-dev", dead); // another device's gone dir → left alone
      const r = palPrune(db);
      assert.deepEqual(r.closed, ["dead"]);
      const openIds = palList(db, { allDevices: true })
        .map((p) => p.id)
        .sort();
      assert.deepEqual(openIds, ["live", "other"].sort());
    });
    rmSync(live, { recursive: true, force: true });
    db.close();
  });

  it("deviceId is stable within a process and overridable", () => {
    assert.equal(deviceId(), deviceId());
    withDevice("pinned", () => assert.equal(deviceId(), "pinned"));
  });
});

describe("deviceIdOverrideActive (KIT_DEVICE_ID trust posture)", () => {
  const withEnv = (val: string | undefined, fn: () => void) => {
    const prev = process.env.KIT_DEVICE_ID;
    if (val === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = val;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.KIT_DEVICE_ID;
      else process.env.KIT_DEVICE_ID = prev;
    }
  };

  it("is false when unset, true for a well-formed override, false for a malformed one", () => {
    withEnv(undefined, () => assert.equal(deviceIdOverrideActive(), false));
    withEnv("laptop-2", () => assert.equal(deviceIdOverrideActive(), true));
    withEnv("   ", () => assert.equal(deviceIdOverrideActive(), false));
    // malformed (spaces/punctuation) is ignored by deviceId() → not "active"
    withEnv("bad id!", () => assert.equal(deviceIdOverrideActive(), false));
  });
});
