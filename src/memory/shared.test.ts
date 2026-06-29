import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shareEntry,
  readShared,
  listAreas,
  queryArea,
  searchShared,
  effectiveStatus,
  activeShared,
  formatAge,
} from "./shared.js";

const ALLOWED = new Set([
  "id",
  "area",
  "kind",
  "title",
  "body",
  "refs",
  "author",
  "ts",
  "source_ref",
  "status",
  "supersedes",
  "reverses",
]);

describe("shared project memory (Track D)", () => {
  const root = () => mkdtempSync(join(tmpdir(), "kit-shared-"));

  it("promotes an entry; only allow-listed fields persist; has provenance", () => {
    const r = root();
    const e = shareEntry(
      r,
      {
        area: "stripe",
        kind: "decision",
        title: "use Connect",
        body: "platform model",
        refs: ["PR #12"],
      },
      "2026-06-16T00:00:00Z",
    );
    assert.match(e.id, /^[0-9a-f]{6}$/);
    assert.ok(e.author.length > 0);
    const all = readShared(r);
    assert.equal(all.length, 1);
    assert.ok(
      Object.keys(all[0] ?? {}).every((k) => ALLOWED.has(k)),
      "no field outside the allow-list is persisted",
    );
    assert.equal(all[0]?.area, "stripe");
    rmSync(r, { recursive: true, force: true });
  });

  it("refuses (fail-closed) an entry containing a secret; nothing is written", () => {
    const r = root();
    const fake = "sk_live_" + "B".repeat(24);
    assert.throws(
      () =>
        shareEntry(
          r,
          { area: "stripe", kind: "note", title: "key", body: `the key is ${fake}` },
          "t",
        ),
      /secret/,
    );
    assert.equal(readShared(r).length, 0);
    rmSync(r, { recursive: true, force: true });
  });

  it("lists areas with counts and queries one area", () => {
    const r = root();
    shareEntry(r, { area: "stripe", kind: "decision", title: "a", body: "x" }, "t1");
    shareEntry(r, { area: "whatsapp", kind: "how-built", title: "b", body: "y" }, "t2");
    shareEntry(r, { area: "whatsapp", kind: "security", title: "c", body: "z" }, "t3");
    assert.deepEqual(listAreas(r), [
      { area: "stripe", count: 1 },
      { area: "whatsapp", count: 2 },
    ]);
    assert.equal(queryArea(r, "whatsapp").length, 2);
    rmSync(r, { recursive: true, force: true });
  });

  it("searches across entries", () => {
    const r = root();
    shareEntry(
      r,
      { area: "whatsapp", kind: "how-built", title: "scheduling bot", body: "runs on cron" },
      "t1",
    );
    assert.equal(searchShared(r, "cron").length, 1);
    assert.equal(searchShared(r, "stripe").length, 0);
    rmSync(r, { recursive: true, force: true });
  });
});

describe("shared memory — decision lifecycle (gap #2)", () => {
  const root = () => mkdtempSync(join(tmpdir(), "kit-life-"));

  it("a plain entry omits status (byte-identical to pre-lifecycle) and is active", () => {
    const r = root();
    const e = shareEntry(r, { area: "a", kind: "decision", title: "x", body: "" }, "t1");
    assert.equal(Object.prototype.hasOwnProperty.call(e, "status"), false, "no status field");
    assert.equal(effectiveStatus(e, [e]), "active");
    rmSync(r, { recursive: true, force: true });
  });

  it("supersedes marks the old entry superseded; reverses marks it reversed", () => {
    const r = root();
    const old = shareEntry(
      r,
      { area: "auth", kind: "decision", title: "use RSA", body: "" },
      "2026-01-01T00:00:00Z",
    );
    shareEntry(
      r,
      { area: "auth", kind: "decision", title: "use Ed25519", body: "", supersedes: old.id },
      "2026-02-01T00:00:00Z",
    );
    const all = readShared(r);
    const oldRead = all.find((e) => e.id === old.id)!;
    assert.equal(effectiveStatus(oldRead, all), "superseded");
    // activeShared keeps only the successor.
    const active = activeShared(r);
    assert.deepEqual(
      active.map((e) => e.title),
      ["use Ed25519"],
    );
    rmSync(r, { recursive: true, force: true });
  });

  it("reverses outranks supersedes and an explicit status wins", () => {
    const r = root();
    const a = shareEntry(r, { area: "x", kind: "decision", title: "A", body: "" }, "t1");
    shareEntry(
      r,
      { area: "x", kind: "decision", title: "B", body: "", reverses: a.id, supersedes: a.id },
      "t2",
    );
    const all = readShared(r);
    assert.equal(effectiveStatus(all.find((e) => e.id === a.id)!, all), "reversed");
    // explicit status on an unreferenced entry wins
    const c = shareEntry(
      r,
      { area: "x", kind: "decision", title: "C", body: "", status: "superseded" },
      "t3",
    );
    assert.equal(effectiveStatus(c, readShared(r)), "superseded");
    rmSync(r, { recursive: true, force: true });
  });

  it("formatAge buckets into today / days / months / years", () => {
    const now = new Date("2026-06-29T00:00:00Z");
    assert.equal(formatAge("2026-06-29T00:00:00Z", now), "today");
    assert.equal(formatAge("2026-06-24T00:00:00Z", now), "5d ago");
    assert.equal(formatAge("2026-03-01T00:00:00Z", now), "4mo ago"); // 120d / 30
    assert.equal(formatAge("2024-01-01T00:00:00Z", now), "2y ago");
    assert.equal(formatAge("not-a-date", now), "");
  });
});
