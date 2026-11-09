import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditCli,
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";
import { externalAuditFixture, externalEvidence } from "./audit-external.test-support.js";

test("required external verification refuses a fabricated receipt without changing evidence", async (t) => {
  const fixture = auditFixture(t, true);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);`,
    ),
  ]);
  // Verify with read-only mode already active. A new activation has its own audit event.
  fixture.env.KIT_READ_ONLY = "1";
  const local = auditCli(fixture, ["verify", "--strict", "--read-only"]);
  assert.equal(local.status, 0, local.stdout + local.stderr);
  const indexPath = join(fixture.home, "anchors", "audit-anchor.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const logPath = Object.keys(index)[0];
  index[logPath].external = {
    token: Buffer.from("fabricated proof, not signed by an authority").toString("base64"),
    authority: "trusted-authority.example",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(indexPath, JSON.stringify(index));
  const beforeIndex = readFileSync(indexPath);
  const beforeLog = readFileSync(logPath);
  const required = auditCli(fixture, ["verify", "--require-external", "--strict", "--read-only"]);
  assert.equal(required.status, 1, required.stdout + required.stderr);
  assert.match(required.stdout + required.stderr, /external.*(unverified|verif|authentic)/i);
  assert.deepEqual(readFileSync(indexPath), beforeIndex);
  assert.deepEqual(readFileSync(logPath), beforeLog);
});

test("all-log verification cannot ignore required external proofs", async (t) => {
  const fixture = auditFixture(t, true);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);`,
    ),
  ]);
  fixture.env.KIT_READ_ONLY = "1";
  const result = auditCli(fixture, ["verify", "--all", "--require-external", "--strict", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.counts.failed, 1);
  assert.match(report.results[0].message, /external/i);
});

test("real external signatures and current checkpoints verify repeatedly without writes", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  fixture.env.KIT_READ_ONLY = "1";
  const before = externalEvidence(fixture);
  for (const flags of [[], [], ["--all", "--json"]]) {
    const verified = auditCli(fixture, ["verify", "--require-external", "--strict", ...flags]);
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    if (flags.length) assert.equal(JSON.parse(verified.stdout).counts.verified, 1);
    else assert.match(verified.stdout, /verified external anchor/);
    assert.deepEqual(externalEvidence(fixture), before);
  }
});
