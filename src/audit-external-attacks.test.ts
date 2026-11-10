import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { auditCli, runAuditWorkers, startAuditWorker } from "./audit-concurrency.test-support.js";
import { externalAuditFixture, externalEvidence } from "./audit-external.test-support.js";
import { externalStatement } from "./audit-external.js";

test("external verification rejects forged signatures and unauthenticated receipt labels", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  fixture.env.KIT_READ_ONLY = "1";
  const original = readFileSync(fixture.indexPath, "utf8");
  for (const attack of ["signature", "authority", "timestamp"]) {
    const index = JSON.parse(original);
    const receipt = index[fixture.logPath].external;
    if (attack === "signature") {
      const envelope = JSON.parse(Buffer.from(receipt.token, "base64").toString("utf8"));
      envelope.signature = sign(
        null,
        Buffer.from(JSON.stringify(envelope.payload)),
        generateKeyPairSync("ed25519").privateKey,
      ).toString("base64");
      receipt.token = Buffer.from(JSON.stringify(envelope)).toString("base64");
    } else receipt[attack] = "attacker-selected-claim";
    writeFileSync(fixture.indexPath, JSON.stringify(index));
    const before = externalEvidence(fixture);
    for (const flags of [[], ["--all", "--json"]]) {
      const checked = auditCli(fixture, ["verify", "--require-external", ...flags]);
      assert.equal(checked.status, 1, attack + checked.stdout + checked.stderr);
      assert.match(checked.stdout + checked.stderr, /external.*INVALID/i);
      assert.deepEqual(externalEvidence(fixture), before);
    }
  }
});

test("external statements bind every local seal field and the actual log", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  fixture.env.KIT_READ_ONLY = "1";
  const original = readFileSync(fixture.indexPath, "utf8");
  const anotherLog = join(fixture.project, "different-log.jsonl");
  copyFileSync(fixture.logPath, anotherLog);
  const alterations = {
    count: 9,
    tip: "f".repeat(64),
    anchorVersion: 2,
    keyFingerprint: "f".repeat(32),
    logPath: anotherLog,
  };
  for (const [field, value] of Object.entries(alterations)) {
    const index = JSON.parse(original);
    index[fixture.logPath].external.statement[field] = value;
    writeFileSync(fixture.indexPath, JSON.stringify(index));
    const before = externalEvidence(fixture);
    const checked = auditCli(fixture, ["verify", "--require-external"]);
    assert.equal(checked.status, 1, field + checked.stdout + checked.stderr);
    assert.match(checked.stdout + checked.stderr, /statement does not match/i);
    assert.deepEqual(externalEvidence(fixture), before);
  }
});

test("a new valid local HMAC seal cannot reuse an old external signature", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  const receipt = JSON.parse(readFileSync(fixture.indexPath, "utf8"))[fixture.logPath].external;
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
      assert.equal(await audit.appendAuditEventDirect(event("later"), { cwd: project }), true);
      const logPath=join(project,".kit-audit.jsonl");
      const record=await anchor.readAnchorRecord(logPath);
      assert.equal(record.count,2);
      assert.equal(anchor.verifyAgainstAnchor(await readFile(logPath,"utf8"),record,await anchor.tryReadAuditAnchorKey()).status,"anchored-ok");
    `,
    ),
  ]);
  const index = JSON.parse(readFileSync(fixture.indexPath, "utf8"));
  // The attacker updates local metadata too. Only the old authority signature remains unavailable to forge.
  receipt.statement = externalStatement(fixture.logPath, index[fixture.logPath]);
  index[fixture.logPath].external = receipt;
  writeFileSync(fixture.indexPath, JSON.stringify(index));
  fixture.env.KIT_READ_ONLY = "1";
  const before = externalEvidence(fixture);
  const checked = auditCli(fixture, ["verify", "--require-external", "--strict"]);
  assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  assert.match(checked.stdout + checked.stderr, /authority rejected the receipt or statement/i);
  assert.deepEqual(externalEvidence(fixture), before);
});

test("an older authentic log and receipt fail against the authority's newer checkpoint", async (t) => {
  const fixture = await externalAuditFixture(t);
  const first = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const old = externalEvidence(fixture);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `assert.equal(await audit.appendAuditEventDirect(event("later"), { cwd: project }), true);`,
    ),
  ]);
  const second = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.notDeepEqual(externalEvidence(fixture).checkpoint, old.checkpoint);
  writeFileSync(fixture.logPath, old.log);
  writeFileSync(fixture.indexPath, old.index);
  fixture.env.KIT_READ_ONLY = "1";
  const before = externalEvidence(fixture);
  for (const flags of [[], ["--all", "--json"]]) {
    const checked = auditCli(fixture, ["verify", "--require-external", ...flags]);
    assert.equal(checked.status, 1, checked.stdout + checked.stderr);
    assert.match(checked.stdout + checked.stderr, /older than the trusted checkpoint/i);
    assert.deepEqual(externalEvidence(fixture), before);
  }
});
