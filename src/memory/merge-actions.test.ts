import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openMemoryDb } from "./db.js";
import { mergeDb } from "./merge.js";
import {
  palAdd,
  palDone,
  palList,
  palRelease,
  palShow,
  palTakeover,
  palSyncFindings,
  importLegacyLedger,
} from "./pal.js";
import { claimTask, seedLegacyPalDb, withPalDevice } from "./pal-fixture.test-support.js";

type Db = ReturnType<typeof openMemoryDb>;
type Row = Record<string, unknown>;
const origin = "/foreign/projects/checkout";
const destination = "/local/projects/checkout";
const mappings = { projectMappings: [{ from: origin, to: destination }] };

function fixture(run: (source: Db, target: Db, path: string) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "kit-merge-actions-"));
  const previous = process.env.KIT_DEVICE_ID;
  process.env.KIT_DEVICE_ID = "destination-device";
  const path = join(tmp, "source.db");
  const source = openMemoryDb(path);
  const target = openMemoryDb(":memory:");
  try {
    run(source, target, path);
  } finally {
    source.close();
    target.close();
    if (previous === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
}

function addSource(source: Db, title = "verify sandbox receipt"): string {
  const cwd = process.cwd;
  process.cwd = () => origin;
  try {
    return withPalDevice("source-device", () =>
      palAdd(source, {
        title,
        scope: origin,
        check: { type: "file-exists", path: "/foreign/receipt" },
      }),
    );
  } finally {
    process.cwd = cwd;
  }
}

function row(db: Db, id: string): Row {
  return db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as Row;
}

function seedLegacySource(path: string, source: Db): void {
  seedLegacyPalDb(path, [{ id: "legacy", title: "legacy work", scope: origin }]);
  const legacy = new DatabaseSync(path);
  try {
    // Empty non-PAL tables supply the enclosing store; the legacy task schema stays independent.
    for (const name of ["sessions", "messages", "tool_uses", "saved_threads"]) {
      const schema = source
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(name)?.sql;
      assert.equal(typeof schema, "string");
      legacy.exec(String(schema));
    }
  } finally {
    legacy.close();
  }
}

it("maps an action into local recall while preserving its identity, device and original paths", () => {
  fixture((source, target, path) => {
    const id = addSource(source);
    const original = row(source, id);
    const result = mergeDb(target, path, mappings);
    const local = row(target, id);
    assert.equal(result.pending, 1);
    assert.equal(local.origin_device, "source-device");
    assert.equal(local.origin_root, origin);
    assert.equal(local.scope, origin);
    assert.equal(local.origin_id, id);
    assert.equal(local.sync_id, original.sync_id);
    assert.equal(typeof local.sync_id, "string");
    assert.equal(local.kind, "manual");
    assert.equal(local.verify_cmd, null);
    assert.equal(local.verify_check, null);
    assert.equal(local.verify_passes, 0);
    assert.equal(palList(target, { scope: destination }).length, 1);
    assert.equal(palList(target, { scope: "/unrelated" }).length, 0);
    assert.deepEqual(row(source, id), original, "import must not rewrite the source");
  });
});

it("keeps a foreign action invisible by default until an explicit mapping is supplied", () => {
  fixture((source, target, path) => {
    const id = addSource(source);
    mergeDb(target, path);
    assert.equal(palList(target).length, 0);
    assert.equal(palList(target, { allDevices: true }).length, 1);
    assert.equal(mergeDb(target, path, mappings).scopeRepairs, 1);
    assert.equal(palList(target, { scope: destination }).length, 1);
    palDone(target, id);
    const closed = row(target, id);
    const repeated = mergeDb(target, path, mappings);
    assert.equal(repeated.pending, 0);
    assert.equal(repeated.scopeRepairs, 0);
    assert.deepEqual(row(target, id), closed, "reimport must preserve local closure");
  });
});

it("does not lose either action when independent stores reuse a short display id", () => {
  fixture((source, target, path) => {
    const id = addSource(source);
    const ledger = join(dirname(path), "local.jsonl");
    writeFileSync(ledger, JSON.stringify({ id, title: "unrelated local work", repo: destination }));
    assert.equal(importLegacyLedger(target, ledger).imported, 1);
    const existing = row(target, id);
    const result = mergeDb(target, path, mappings);
    assert.equal(result.pending, 1);
    const all = palList(target, { scope: destination });
    assert.equal(all.length, 2);
    const imported = all.find((action) => action.title === "verify sandbox receipt")!;
    assert.notEqual(imported.id, id);
    assert.equal(row(target, imported.id).origin_id, id);
    assert.deepEqual(row(target, id), existing);
    assert.equal(mergeDb(target, path, mappings).pending, 0);
    assert.equal(palList(target, { scope: destination }).length, 2);
  });
});

it("preserves a source claim until explicit local takeover and retains takeover on repeat import", () => {
  fixture((source, target, path) => {
    const id = addSource(source);
    const sourceClaim = withPalDevice("source-device", () =>
      claimTask(source, id, "source-agent", "claude"),
    );
    const original = row(source, id);
    mergeDb(target, path, mappings);
    assert.equal(row(target, id).claimed_by, "source-agent");
    assert.equal(row(target, id).claimed_at, row(source, id).claimed_at);
    assert.deepEqual(palShow(target, id)!.heads[0].state.claim_owner, sourceClaim.owner);
    const localClaim = {
      owner: { device: "destination-device", harness: "codex", session: "local-agent" },
      expectedFrontier: palShow(target, id)!.frontier,
      label: "local-agent",
    };
    assert.throws(() => palRelease(target, id, localClaim), { code: "not-owner" });
    assert.equal(palTakeover(target, id, localClaim).status, "applied");
    assert.equal(row(target, id).claimed_by, "local-agent");
    assert.deepEqual(palShow(target, id)!.heads[0].state.claim_owner, localClaim.owner);
    const claimed = row(target, id);
    mergeDb(target, path, mappings);
    assert.deepEqual(row(target, id), claimed);
    assert.deepEqual(row(source, id), original);
  });
});

it("advances an unchanged local ancestor to its observed source completion", () => {
  fixture((source, target, path) => {
    const id = addSource(source);
    mergeDb(target, path, mappings);
    palDone(source, id);
    const result = mergeDb(target, path, mappings);
    assert.ok("pendingStateDifferences" in result);
    assert.equal(result.pendingStateDifferences, 0);
    assert.equal(row(target, id).status, "closed");
  });
});

it("does not import a previous machine's local recall aliases", () => {
  fixture((source, target, path) => {
    const id = addSource(source);
    source
      .prepare("UPDATE pending_actions SET recall_scope = ?, recall_device = ? WHERE id = ?")
      .run(destination, "destination-device", id);
    mergeDb(target, path);
    assert.equal(row(target, id).recall_scope, null);
    assert.equal(row(target, id).recall_device, null);
    assert.equal(palList(target, { scope: destination }).length, 0);
  });
});

it("keeps portable identity stable across reopen and forwarding through another store", () => {
  fixture((source, target, path) => {
    const id = addSource(source);
    const original = row(source, id);
    const reopened = openMemoryDb(path);
    assert.equal(row(reopened, id).sync_id, original.sync_id);
    reopened.close();
    mergeDb(target, path, mappings);
    const forwarded = join(dirname(path), "forwarded.db");
    target.prepare("VACUUM INTO ?").run(forwarded);
    const third = openMemoryDb(":memory:");
    try {
      mergeDb(third, forwarded, { projectMappings: [{ from: origin, to: "/third/checkout" }] });
      const copy = row(third, id);
      assert.equal(copy.sync_id, original.sync_id);
      assert.equal(copy.origin_id, id);
      assert.equal(copy.origin_device, "source-device");
      assert.equal(copy.origin_root, origin);
      assert.equal(copy.recall_scope, "/third/checkout");
      assert.equal(
        mergeDb(third, path).pending,
        0,
        "direct and forwarded imports converge by identity",
      );
    } finally {
      third.close();
    }
  });
});

it("imports pre-identity snapshots idempotently without trusting missing device provenance", () => {
  fixture((source, target, path) => {
    const id = "legacy";
    const legacyPath = join(dirname(path), "legacy.db");
    seedLegacySource(legacyPath, source);
    const first = mergeDb(target, legacyPath);
    assert.equal(first.pending, 1);
    assert.equal(first.pendingLegacySnapshots, 1);
    assert.equal(palList(target).length, 0);
    assert.equal(palList(target, { allDevices: true }).length, 1);
    assert.equal(mergeDb(target, legacyPath, mappings).pending, 0);
    assert.equal(palList(target, { scope: destination }).length, 1);
    assert.equal(row(target, id).origin_device, null);
    const legacy = new DatabaseSync(legacyPath);
    try {
      legacy
        .prepare("UPDATE pending_actions SET title = ? WHERE id = ?")
        .run("revised legacy snapshot", id);
    } finally {
      legacy.close();
    }
    assert.equal(mergeDb(target, legacyPath, mappings).pending, 1);
    assert.equal(
      palList(target, { scope: destination }).length,
      2,
      "legacy snapshots cannot overwrite each other",
    );
  });
});

it("rejects conflicting portable identity without modifying the retained action", () => {
  fixture((source, target, path) => {
    const id = addSource(source);
    mergeDb(target, path, mappings);
    const retained = row(target, id);
    // A malicious database owner can remove local guards; import must still validate origin.
    source.exec("DROP TRIGGER pal_state_update");
    source
      .prepare("UPDATE pending_actions SET origin_device = ? WHERE id = ?")
      .run("forged-device", id);
    assert.throws(() => mergeDb(target, path, mappings), /conflicting origin/);
    assert.deepEqual(row(target, id), retained);
  });
});

it("source migration does not resurrect a legacy snapshot closed after import", () => {
  fixture((source, target, path) => {
    const id = "legacy";
    const legacyPath = join(dirname(path), "legacy.db");
    seedLegacySource(legacyPath, source);
    mergeDb(target, legacyPath, mappings);
    palDone(target, id);
    const retained = row(target, id);
    const upgraded = openMemoryDb(legacyPath);
    upgraded.close();
    const imported = mergeDb(target, legacyPath, mappings);
    assert.equal(imported.pending, 0);
    assert.equal(imported.pendingLegacySnapshots, 0);
    assert.equal(palList(target, { scope: destination }).length, 0);
    assert.deepEqual(row(target, id), retained);
  });
});

it("treats contradictory source roots as an identity conflict", () => {
  fixture((source, target, path) => {
    const id = addSource(source);
    mergeDb(target, path, mappings);
    const retained = row(target, id);
    // Crafted external bytes are not constrained by the receiver's writer guards.
    source.exec("DROP TRIGGER pal_state_update");
    source
      .prepare("UPDATE pending_actions SET origin_root = ? WHERE id = ?")
      .run("/forged/root", id);
    assert.throws(() => mergeDb(target, path, mappings), /conflicting origin/);
    assert.deepEqual(row(target, id), retained);
  });
});

it("a local rescan creates its own finding instead of re-attributing an imported one", () => {
  fixture((source, target, path) => {
    const finding = { dedupKey: "missing-header", title: "Missing header" };
    process.env.KIT_DEVICE_ID = "source-device";
    palSyncFindings(source, "sec", [finding], { scope: origin });
    const id = palList(source)[0].id;
    palDone(source, id);
    process.env.KIT_DEVICE_ID = "destination-device";
    mergeDb(target, path, mappings);
    const original = row(target, id);
    palSyncFindings(target, "sec", [finding], { scope: origin });
    assert.deepEqual(row(target, id), original);
    const own = palList(target, { scope: origin });
    assert.equal(own.length, 1);
    assert.equal(own[0].origin_device, "destination-device");
    assert.equal(own[0].kind, "finding");
    assert.notEqual(own[0].id, id);
    const forwarded = join(dirname(path), "rescanned.db");
    target.prepare("VACUUM INTO ?").run(forwarded);
    assert.doesNotThrow(() => mergeDb(source, forwarded));
  });
});
