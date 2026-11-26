import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildSnapshot, compareSnapshot, allChanged } from "./secrets-incident.js";

const OLD = "fakeold-value-a1";

describe("incident snapshot", () => {
  it("is keyed per snapshot: never a plain hash, never comparable across snapshots", () => {
    const a = buildSnapshot("1password", [{ name: "K", value: OLD }], null);
    const b = buildSnapshot("1password", [{ name: "K", value: OLD }], null);
    const plain = createHash("sha256").update(OLD).digest("hex");
    assert.notEqual(a.keys[0]!.fingerprint, plain);
    assert.notEqual(a.keys[0]!.fingerprint, b.keys[0]!.fingerprint);
    assert.ok(!JSON.stringify(a).includes(OLD));
  });

  it("counts only a re-read, different value as changed", () => {
    const snap = buildSnapshot(
      "env",
      [
        { name: "A", value: OLD },
        { name: "B", value: OLD },
        { name: "C", value: OLD },
        { name: "D", value: null },
      ],
      null,
    );
    const rows = compareSnapshot(snap, [
      { name: "A", value: "fakenew-1" },
      { name: "B", value: OLD },
      { name: "C", value: null },
      { name: "D", value: "fakenew-2" },
    ]);
    assert.deepEqual(
      rows.map((r) => r.outcome),
      ["changed", "unchanged", "unresolvable", "no-baseline"],
    );
    assert.equal(allChanged(rows), false);
    assert.equal(allChanged(rows.slice(0, 1)), true);
    assert.equal(allChanged([]), false);
  });
});
