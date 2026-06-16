import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shareEntry, readShared, listAreas, queryArea, searchShared } from "./shared.js";

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
]);

describe("shared project memory (Track D)", () => {
  const root = () => mkdtempSync(join(tmpdir(), "kit-shared-"));

  it("promotes an entry; only allow-listed fields persist; has provenance", () => {
    const r = root();
    const e = shareEntry(
      r,
      { area: "stripe", kind: "decision", title: "use Connect", body: "platform model", refs: ["PR #12"] },
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
      () => shareEntry(r, { area: "stripe", kind: "note", title: "key", body: `the key is ${fake}` }, "t"),
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
    shareEntry(r, { area: "whatsapp", kind: "how-built", title: "scheduling bot", body: "runs on cron" }, "t1");
    assert.equal(searchShared(r, "cron").length, 1);
    assert.equal(searchShared(r, "stripe").length, 0);
    rmSync(r, { recursive: true, force: true });
  });
});
