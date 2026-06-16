import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb, upsertSession, insertMessage } from "./db.js";
import { scanDbForSecrets } from "./scan.js";

describe("memory secret-scan", () => {
  it("flags a stored secret (masked) and locates it", () => {
    const db = openMemoryDb(":memory:");
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    // synthetic, non-real key matching the stripe pattern
    const fake = "sk_live_" + "A".repeat(24);
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: `the key is ${fake}` });
    insertMessage(db, { uuid: "u2", sessionId: "s1", type: "user", content: "totally clean message" });
    const hits = scanDbForSecrets(db);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.label, "stripe-key");
    assert.equal(hits[0]?.table, "messages");
    assert.equal(hits[0]?.column, "content");
    assert.ok(!hits[0]?.preview.includes("A".repeat(24)), "preview is masked, not the raw secret");
    db.close();
  });

  it("returns nothing for a clean db", () => {
    const db = openMemoryDb(":memory:");
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: "no secrets here" });
    assert.deepEqual(scanDbForSecrets(db), []);
    db.close();
  });
});
