import assert from "node:assert/strict";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditCli,
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";
import { externalAuditFixture, externalEvidence } from "./audit-external.test-support.js";

test("required external verification cannot pass an empty union", (t) => {
  const fixture = auditFixture(t);
  fixture.env.KIT_READ_ONLY = "1";
  for (const flags of [[], ["--all"], ["--all", "--json"]]) {
    const checked = auditCli(fixture, ["verify", "--require-external", ...flags]);
    assert.equal(checked.status, 1, checked.stdout + checked.stderr);
    if (flags.includes("--json")) assert.equal(JSON.parse(checked.stdout).ok, false);
  }
});

test("a valid external prefix cannot approve an unsealed tail", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  fixture.env.KIT_AUDIT_ANCHOR = "0";
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `assert.equal(await audit.appendAuditEventDirect(event("unsealed"), { cwd: project }), true);`,
    ),
  ]);
  fixture.env.KIT_READ_ONLY = "1";
  const before = externalEvidence(fixture);
  const one = auditCli(fixture, ["verify", "--require-external"]);
  assert.equal(one.status, 1, one.stdout + one.stderr);
  assert.match(one.stdout + one.stderr, /UNSEALED/);
  const all = auditCli(fixture, ["verify", "--all", "--require-external", "--json"]);
  assert.equal(all.status, 1, all.stdout + all.stderr);
  assert.equal(JSON.parse(all.stdout).results[0].detail, "unsealed-tail");
  assert.deepEqual(externalEvidence(fixture), before);
});

test("missing or changed local evidence cannot satisfy external policy", async (t) => {
  const fixture = await externalAuditFixture(t);
  const sealed = auditCli(fixture, ["anchor", "--external"]);
  assert.equal(sealed.status, 0, sealed.stdout + sealed.stderr);
  fixture.env.KIT_READ_ONLY = "1";
  const keyPath = join(fixture.home, "anchors", "audit-anchor.key");
  const key = readFileSync(keyPath);
  for (const absent of [false, true]) {
    if (absent) unlinkSync(keyPath);
    else writeFileSync(keyPath, "b".repeat(64));
    for (const flags of [[], ["--all", "--json"]]) {
      const checked = auditCli(fixture, ["verify", "--require-external", ...flags]);
      assert.equal(checked.status, 1, checked.stdout + checked.stderr);
    }
  }
  assert.equal(existsSync(keyPath), false);
  writeFileSync(keyPath, key);
  unlinkSync(fixture.logPath);
  for (const flags of [[], ["--all", "--json"]]) {
    const checked = auditCli(fixture, ["verify", "--require-external", ...flags]);
    assert.equal(checked.status, 1, checked.stdout + checked.stderr);
  }
  assert.equal(existsSync(fixture.logPath), false);
});
