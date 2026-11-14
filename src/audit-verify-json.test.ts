import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  auditCli,
  auditFixture,
  runAuditWorkers,
  startAuditWorker,
} from "./audit-concurrency.test-support.js";

test("single-log JSON verification reports a legacy chain failure without exposing events", (t) => {
  const fixture = auditFixture(t);
  const logPath = join(fixture.project, ".kit-audit.jsonl");
  const content = JSON.stringify({ operation: "private-event-sentinel" }) + "\n";
  writeFileSync(logPath, content);

  const result = auditCli(fixture, ["verify", "--json"]);

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.logPath, realpathSync(logPath));
  assert.deepEqual(report.chain, {
    ok: false,
    entries: 0,
    brokenAt: 0,
    reason: "missing hash (unchained entry)",
  });
  assert.equal(report.signatures, null);
  assert.equal(report.anchor, null);
  assert.doesNotMatch(result.stdout + result.stderr, /private-event-sentinel/);
  assert.equal(readFileSync(logPath, "utf8"), content);
  const text = auditCli(fixture, ["verify"]);
  assert.equal(text.status, 1);
  assert.equal(text.stdout, "");
  assert.match(text.stderr, /audit chain BROKEN at entry 0: missing hash/);
});

for (const { flags, anchored, status, anchorStatus, level } of [
  { flags: [], anchored: false, status: 0, anchorStatus: "no-anchor", level: "warn" },
  { flags: ["--strict"], anchored: false, status: 1, anchorStatus: "no-anchor", level: "error" },
  { flags: ["--strict"], anchored: true, status: 0, anchorStatus: "anchored-ok", level: "ok" },
  {
    flags: ["--require-external"],
    anchored: true,
    status: 1,
    anchorStatus: "anchored-ok",
    level: "error",
  },
]) {
  test(`JSON verification preserves anchor verdict: ${anchorStatus}, ${flags}, ${level}`, async (t) => {
    const fixture = auditFixture(t, anchored);
    await runAuditWorkers([
      startAuditWorker(
        fixture,
        `
        assert.equal(await audit.appendAuditEventDirect(event("private-event-sentinel"), { cwd: project }), true);
      `,
      ),
    ]);

    const result = auditCli(fixture, ["verify", "--json", ...flags]);

    assert.equal(result.status, status, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, status === 0);
    assert.deepEqual(report.chain, { ok: true, entries: 1 });
    assert.equal(report.signatures.unsigned, 1);
    assert.equal(report.anchor.status, anchorStatus);
    assert.equal(report.anchor.verdict.level, level);
    assert.doesNotMatch(result.stdout + result.stderr, /private-event-sentinel/);
    const text = auditCli(fixture, ["verify", ...flags]);
    assert.equal(text.status, result.status);
    assert.match(text.stdout, /audit chain intact/);
    assert.match(text.stdout + text.stderr, /HMAC anchor|unanchored/);
  });
}

test("JSON verification identifies malformed records without printing their contents", (t) => {
  const fixture = auditFixture(t);
  writeFileSync(join(fixture.project, ".kit-audit.jsonl"), '{"private-event-sentinel":');
  const result = auditCli(fixture, ["verify", "--read-only", "--json"]);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).chain, {
    ok: false,
    entries: 0,
    brokenAt: 0,
    reason: "unparseable line",
  });
  assert.doesNotMatch(result.stdout + result.stderr, /private-event-sentinel/);
});

for (const strict of [false, true]) {
  test(`JSON verification preserves missing-log policy (strict=${strict})`, (t) => {
    const fixture = auditFixture(t);
    const result = auditCli(fixture, ["verify", "--json", ...(strict ? ["--strict"] : [])]);
    assert.equal(result.status, strict ? 1 : 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, !strict);
    assert.equal(report.chain, null);
    assert.equal(report.anchor, null);
    assert.match(report.reason, /unavailable.*nothing verified/);
  });
}

for (const signature of ["valid", "invalid", "unknown", "revoked"]) {
  test(`JSON verification preserves ${signature} signature semantics`, async (t) => {
    const fixture = auditFixture(t);
    await runAuditWorkers([
      startAuditWorker(
        fixture,
        `
        const { loadOrCreateIdentity, recordRevocation } = await import(${JSON.stringify(new URL("./identity.js", import.meta.url).href)});
        const { identity } = loadOrCreateIdentity();
        assert.equal(await audit.appendAuditEventDirect(event("signed"), { cwd: project }), true);
        if (${JSON.stringify(signature)} === "revoked") recordRevocation(identity.id, "fixture");
      `,
      ),
    ]);
    const logPath = join(fixture.project, ".kit-audit.jsonl");
    const entry = JSON.parse(readFileSync(logPath, "utf8"));
    if (signature === "invalid") entry.sig = "AA==";
    if (signature === "unknown") entry.kid = "unknown-fixture-key";
    writeFileSync(logPath, JSON.stringify(entry) + "\n");

    const result = auditCli(fixture, ["verify", "--json"]);
    assert.equal(result.status, signature === "invalid" ? 1 : 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.chain.ok, true);
    assert.equal(report.signatures.signed, 1);
    assert.equal(report.signatures.verified, ["valid", "revoked"].includes(signature) ? 1 : 0);
    assert.equal(report.signatures.invalid, signature === "invalid" ? 1 : 0);
    assert.equal(report.signatures.unverifiable, signature === "unknown" ? 1 : 0);
    assert.equal(report.signatures.revoked, signature === "revoked" ? 1 : 0);
    if (signature === "invalid") assert.equal(report.anchor, null);
    const text = auditCli(fixture, ["verify"]);
    assert.equal(text.status, result.status);
    assert.match(text.stdout, /identity signatures/);
    if (signature === "invalid") assert.match(text.stderr, /INVALID signature/);
    if (signature === "revoked") assert.match(text.stderr, /signed by a REVOKED key/);
  });
}

test("JSON verification refuses an unauthenticated receipt without disclosing its token", async (t) => {
  const fixture = auditFixture(t, true);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
      assert.equal(await audit.appendAuditEventDirect(event("seed"), { cwd: project }), true);
    `,
    ),
  ]);
  const indexPath = join(fixture.home, "anchors", "audit-anchor.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index[Object.keys(index)[0]].external = {
    token: "private-receipt-sentinel",
    authority: "fixture",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(indexPath, JSON.stringify(index));

  const result = auditCli(fixture, ["verify", "--require-external", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.anchor.status, "anchored-ok");
  assert.equal(report.anchor.externalVerification.status, "unverified");
  assert.equal(report.anchor.externalReceipt, undefined);
  assert.doesNotMatch(result.stdout + result.stderr, /private-receipt-sentinel/);
});

test("JSON verification preserves an unsealed-tail refusal", async (t) => {
  const fixture = auditFixture(t, true);
  await runAuditWorkers([
    startAuditWorker(
      fixture,
      `
      assert.equal(await audit.appendAuditEventDirect(event("sealed"), { cwd: project }), true);
      process.env.KIT_AUDIT_ANCHOR = "0";
      assert.equal(await audit.appendAuditEventDirect(event("unsealed"), { cwd: project }), true);
    `,
    ),
  ]);
  const result = auditCli(fixture, ["verify", "--strict", "--read-only", "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.chain.ok, true);
  assert.equal(report.anchor.status, "anchored-ok");
  assert.equal(report.anchor.newSinceAnchor, 1);
  assert.equal(report.anchor.verdict.level, "error");
});
