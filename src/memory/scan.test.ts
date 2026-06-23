import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb, upsertSession, insertMessage } from "./db.js";
import { scanDbForSecrets } from "./scan.js";

describe("memory secret-scan", () => {
  it("flags a stored secret (masked, high-confidence) and locates it", () => {
    const db = openMemoryDb(":memory:");
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    const fake = "sk_live_" + "A".repeat(24); // synthetic, non-real
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: `the key is ${fake}` });
    insertMessage(db, {
      uuid: "u2",
      sessionId: "s1",
      type: "user",
      content: "totally clean message",
    });
    const findings = scanDbForSecrets(db);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.label, "stripe-key");
    assert.equal(findings[0]?.confidence, "high");
    assert.equal(findings[0]?.count, 1);
    assert.match(findings[0]?.sample ?? "", /^messages#\d+\.content$/);
    assert.ok(
      !findings[0]?.preview.includes("A".repeat(24)),
      "preview is masked, not the raw secret",
    );
    db.close();
  });

  it("dedupes the same secret across rows with an occurrence count", () => {
    const db = openMemoryDb(":memory:");
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    const fake = "sk_live_" + "B".repeat(24);
    insertMessage(db, { uuid: "u1", sessionId: "s1", type: "user", content: `key ${fake}` });
    insertMessage(db, { uuid: "u2", sessionId: "s1", type: "user", content: `again ${fake}` });
    const findings = scanDbForSecrets(db);
    assert.equal(findings.length, 1, "one unique finding, not two");
    assert.equal(findings[0]?.count, 2);
    db.close();
  });

  it("attributes a finding to the project it leaked in (via cwd)", () => {
    const db = openMemoryDb(":memory:");
    upsertSession(db, { sessionId: "s1", harness: "claude-code" });
    const fake = "sk_live_" + "C".repeat(24);
    insertMessage(db, {
      uuid: "u1",
      sessionId: "s1",
      type: "user",
      content: `key ${fake}`,
      cwd: "/Users/me/dev/app-a",
    });
    const findings = scanDbForSecrets(db);
    assert.deepEqual(findings[0]?.projects, ["app-a"]);
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
