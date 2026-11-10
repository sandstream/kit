import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { cmdInsight } from "./insight.js";
import {
  addCall,
  addMessage,
  captureFixture,
  loadedFixture,
} from "../insight/capture-coverage.test-support.js";

for (const json of [false, true]) {
  it(`insight reports incomplete capture without false UNUSED labels or removal suggestions (${json ? "json" : "text"})`, async (t) => {
    const { db, project } = await captureFixture(t);
    loadedFixture(project);
    addMessage(db, "complete", 1, "session", 2);
    addMessage(db, "partial", 0);
    addCall(db, "complete", "mcp__referenced__tool", "{}", "denied");
    addCall(db, "complete", "Skill", '{"skill":"referenced-skill"}', "error");
    process.argv = ["node", "kit", "insight", "unused", ...(json ? ["--json"] : [])];
    const lines: string[] = [];
    t.mock.method(console, "log", (...values: unknown[]) => lines.push(values.join(" ")));
    assert.equal(await cmdInsight(), true);
    const output = lines.join("\n");
    if (json) {
      const report = JSON.parse(output);
      assert.deepEqual(report.pruneCandidates, []);
      assert.equal(report.capture.complete, false);
      assert.equal(report.capture.incompleteMessages, 1);
      assert.equal(
        report.findings.find((finding: { name: string }) => finding.name === "missing")?.verdict,
        "unknown",
      );
      assert.equal(
        report.findings.find((finding: { name: string }) => finding.name === "referenced")?.verdict,
        "used",
      );
    } else {
      assert.doesNotMatch(output, /UNUSED|prune candidates/);
      assert.match(output, /unknown.*missing/);
      assert.match(output, /used.*referenced/);
      assert.match(output, /capture.*incomplete/i);
    }
  });
}

it("insight reports unknown without creating a missing memory store", async (t) => {
  const { root, project } = await captureFixture(t);
  loadedFixture(project);
  const absent = join(root, "absent");
  process.env.KIT_MEMORY_DB = join(absent, "memory.db");
  process.env.KIT_MEMORY_DIR = absent;
  process.argv = ["node", "kit", "insight", "unused", "--json"];
  const lines: string[] = [];
  t.mock.method(console, "log", (...values: unknown[]) => lines.push(values.join(" ")));
  assert.equal(await cmdInsight(), true);
  const report = JSON.parse(lines.join("\n"));
  assert.equal(report.skipped, true);
  assert.equal(report.capture.complete, false);
  assert.equal(report.findings.length, 4);
  assert.ok(report.findings.every((finding: { verdict: string }) => finding.verdict === "unknown"));
  assert.deepEqual(report.pruneCandidates, []);
  assert.equal(existsSync(absent), false);
});

it("insight reads schema17 without migration and explains missing capture evidence", async (t) => {
  const { db, project } = await captureFixture(t);
  loadedFixture(project);
  addMessage(db, "legacy", 1, "session", 1);
  addCall(db, "legacy", "mcp__referenced__tool");
  db.exec(
    "ALTER TABLE messages DROP COLUMN tool_capture_version; UPDATE schema_meta SET version = 17",
  );
  process.argv = ["node", "kit", "insight", "unused", "--json"];
  const lines: string[] = [];
  t.mock.method(console, "log", (...values: unknown[]) => lines.push(values.join(" ")));
  assert.equal(await cmdInsight(), true);
  assert.equal(db.prepare("SELECT version FROM schema_meta").get()?.version, 17);
  assert.equal(
    db
      .prepare("PRAGMA table_info(messages)")
      .all()
      .some((column) => column.name === "tool_capture_version"),
    false,
  );
  const report = JSON.parse(lines.join("\n"));
  assert.equal(report.capture.complete, false);
  assert.deepEqual(report.pruneCandidates, []);
  assert.equal(
    report.findings.find((finding: { name: string }) => finding.name === "missing")?.verdict,
    "unknown",
  );
});

for (const messages of [0, 1]) {
  it(`insight distinguishes an empty store from ${messages ? "covered history without calls" : "no observed history"}`, async (t) => {
    const { db, project } = await captureFixture(t);
    loadedFixture(project);
    if (messages) addMessage(db, "no-tools");
    process.argv = ["node", "kit", "insight", "unused", "--json"];
    const lines: string[] = [];
    t.mock.method(console, "log", (...values: unknown[]) => lines.push(values.join(" ")));
    assert.equal(await cmdInsight(), true);
    const report = JSON.parse(lines.join("\n"));
    assert.equal(report.capture.complete, messages > 0);
    assert.equal(report.scope, "retained-indexed-messages");
    assert.equal(report.findings.length, 4);
    assert.ok(
      report.findings.every(
        (finding: { kind: string; verdict: string }) =>
          finding.verdict === (messages && finding.kind === "mcp-server" ? "unused" : "unknown"),
      ),
    );
    assert.equal(report.pruneCandidates.length, messages ? 2 : 0);
    assert.equal(report.skillCoverage, "explicit-references-only");
    assert.equal(report.skipped, messages === 0);
  });
}

it("insight bounds complete Codex MCP absence and leaves skills unknown in text", async (t) => {
  const { db, project } = await captureFixture(t);
  loadedFixture(project);
  db.prepare("INSERT INTO sessions (session_id, harness) VALUES ('session', 'codex')").run();
  addMessage(db, "codex", 1, "session", 2);
  addCall(db, "codex", "Read", '{"file_path":".claude/skills/missing-skill/SKILL.md"}', "returned");
  addCall(db, "codex", "mcp__referenced__tool", "{}", "returned");
  process.argv = ["node", "kit", "insight", "unused"];
  const lines: string[] = [];
  t.mock.method(console, "log", (...values: unknown[]) => lines.push(values.join(" ")));
  assert.equal(await cmdInsight(), true);
  const output = lines.join("\n");
  assert.match(output, /Tool capture: complete/);
  assert.match(output, /UNUSED.*missing.*no recorded reference within covered history/);
  assert.match(output, /unknown.*missing-skill/);
  assert.doesNotMatch(output, /UNUSED.*skill|never (?:used|called|invoked)/i);
  assert.match(output, /Skill coverage: explicit references only/);
  assert.match(output, /Scope: retained indexed messages/);
  assert.match(output, /Unindexed history and uncaptured subagents remain unknown/);
  const pruneLine = lines.find((line) => line.includes("prune candidates"));
  assert.ok(pruneLine?.includes("missing"));
  assert.ok(!pruneLine?.includes("-skill"));
});

it("insight keeps missing references unknown after call rows are omitted from captured messages", async (t) => {
  const { db, project } = await captureFixture(t);
  loadedFixture(project);
  addMessage(db, "partial", 1, "session", 2);
  addCall(db, "partial", "mcp__referenced__tool", "{}", "returned");
  process.argv = ["node", "kit", "insight", "unused"];
  const lines: string[] = [];
  t.mock.method(console, "log", (...values: unknown[]) => lines.push(values.join(" ")));
  assert.equal(await cmdInsight(), true);
  const output = lines.join("\n");
  assert.match(output, /capture: incomplete.*1\/1/);
  assert.match(output, /unknown.*missing/);
  assert.match(output, /used.*referenced/);
  assert.doesNotMatch(output, /UNUSED|prune candidates/);
});
