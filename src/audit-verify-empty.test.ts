import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { auditCli, auditFixture } from "./audit-concurrency.test-support.js";
import { nothingVerified } from "./audit-verify-empty.js";

// An empty log is its own outcome. It is not "an intact chain with 0 entries": a log that
// was emptied and a log that never held an event look the same, and neither was verified.
for (const [name, content] of [
  ["zero bytes", ""],
  ["blank lines only", "\n \n\n"],
] as const) {
  test(`verify reports an empty log (${name}) as nothing verified, not as intact`, (t) => {
    const fixture = auditFixture(t);
    const logPath = join(fixture.project, ".kit-audit.jsonl");
    writeFileSync(logPath, content);

    const text = auditCli(fixture, ["verify"]);
    assert.equal(text.status, 0, text.stderr);
    assert.doesNotMatch(text.stdout + text.stderr, /audit chain intact/);
    assert.match(text.stderr, /audit log at .* is empty/);
    assert.match(text.stderr, /nothing verified/);

    const json = auditCli(fixture, ["verify", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.reason, "audit log is empty; nothing verified");
    assert.equal(report.chain, null);
    assert.equal(report.anchor, null);

    assert.equal(readFileSync(logPath, "utf8"), content, "verify must not rewrite the log");
  });

  test(`verify --strict fails on an empty log (${name})`, (t) => {
    const fixture = auditFixture(t);
    const logPath = join(fixture.project, ".kit-audit.jsonl");
    writeFileSync(logPath, content);

    const text = auditCli(fixture, ["verify", "--strict"]);
    assert.equal(text.status, 1);
    assert.doesNotMatch(text.stdout + text.stderr, /audit chain intact/);
    assert.match(text.stderr, /audit log at .* is empty/);

    const json = auditCli(fixture, ["verify", "--strict", "--json"]);
    assert.equal(json.status, 1);
    const report = JSON.parse(json.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.reason, "audit log is empty; nothing verified");

    assert.equal(readFileSync(logPath, "utf8"), content, "verify must not rewrite the log");
  });
}

test("a missing log and an empty log give different messages", (t) => {
  const fixture = auditFixture(t);
  const missing = auditCli(fixture, ["verify"]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /no audit log at/);
  assert.doesNotMatch(missing.stderr, /is empty/);

  const json = JSON.parse(auditCli(fixture, ["verify", "--json"]).stdout);
  assert.equal(json.reason, "audit log unavailable; nothing verified");
});

test("verify --all fails on a seal with no log entries", (t) => {
  const fixture = auditFixture(t);
  const logPath = join(fixture.project, ".kit-audit.jsonl");
  writeFileSync(logPath, "\n");
  const anchor = auditCli(fixture, ["anchor"]);
  assert.equal(anchor.status, 0, anchor.stdout + anchor.stderr);
  const indexPath = join(fixture.home, "anchors", "audit-anchor.json");
  const index = readFileSync(indexPath);

  const result = auditCli(fixture, ["verify", "--all", "--json"]);
  const report = JSON.parse(result.stdout);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(report.ok, false);
  assert.deepEqual(report.counts, { verified: 0, stalled: 0, missing: 0, failed: 1 });
  assert.equal(report.results[0].detail, "empty-log");
  assert.equal(report.results[0].entries, 0);
  assert.equal(readFileSync(logPath, "utf8"), "\n");
  assert.deepEqual(readFileSync(indexPath), index);
});

test("an unreadable log fails instead of reporting a fresh install", (t) => {
  const fixture = auditFixture(t);
  const logPath = join(fixture.project, ".kit-audit.jsonl");
  mkdirSync(logPath);
  writeFileSync(join(logPath, "keep"), "evidence");

  const result = auditCli(fixture, ["verify", "--json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.reason, "audit log could not be read; nothing verified");
  assert.equal(report.chain, null);
  assert.equal(readFileSync(join(logPath, "keep"), "utf8"), "evidence");
});

test("nothingVerified: a missing log and an empty log are separate, and both can fail", () => {
  const missing = nothingVerified("missing", "/p/log", false);
  const empty = nothingVerified("empty", "/p/log", false);
  assert.equal(missing.ok, true);
  assert.equal(empty.ok, true);
  assert.notEqual(missing.reason, empty.reason);
  assert.match(empty.message, /^the audit log at \/p\/log is empty \(nothing verified\)$/);

  for (const kind of ["missing", "empty"] as const) {
    const refused = nothingVerified(kind, "/p/log", true);
    assert.equal(refused.ok, false);
    assert.match(refused.message, /refusing to report verified/i);
  }
});
