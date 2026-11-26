import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { buildSnapshot, compareSnapshot, allChanged } from "./secrets-incident.js";
import { incidentKeyId } from "./secrets-incident-key.js";

const OLD = "fakeold-value-a1";

describe("incident snapshot", () => {
  it("is keyed per snapshot: never a plain hash, never comparable across snapshots", () => {
    const a = buildSnapshot("1password", [{ name: "K", value: OLD }], null, randomBytes(32));
    const b = buildSnapshot("1password", [{ name: "K", value: OLD }], null, randomBytes(32));
    const plain = createHash("sha256").update(OLD).digest("hex");
    assert.notEqual(a.keys[0]!.fingerprint, plain);
    assert.notEqual(a.keys[0]!.fingerprint, b.keys[0]!.fingerprint);
    assert.ok(!JSON.stringify(a).includes(OLD));
  });

  it("holds only a key id, never the key", () => {
    const key = randomBytes(32);
    const snap = buildSnapshot("env", [{ name: "K", value: OLD }], null, key);
    const text = JSON.stringify(snap);
    assert.equal(snap.keyId, incidentKeyId(key));
    assert.match(snap.keyId, /^ik_[0-9a-f]{32}$/);
    for (const enc of ["hex", "base64", "base64url"] as const) {
      assert.ok(!text.includes(key.toString(enc)), `key leaked as ${enc}`);
    }
    assert.ok(!("hmacKey" in snap));
    assert.throws(() => compareSnapshot(snap, randomBytes(32), []), /key id mismatch/);
  });

  it("counts only a re-read, different value as changed", () => {
    const key = randomBytes(32);
    const snap = buildSnapshot(
      "env",
      [
        { name: "A", value: OLD },
        { name: "B", value: OLD },
        { name: "C", value: OLD },
        { name: "D", value: null },
      ],
      null,
      key,
    );
    const rows = compareSnapshot(snap, key, [
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
