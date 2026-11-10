import assert from "node:assert/strict";
import { it } from "node:test";
import { computeUnused } from "./unused.js";
import { scanSkillUsage, scanToolCapture, scanToolUsage } from "./usage-scan.js";
import { addCall, addMessage, captureFixture } from "./capture-coverage.test-support.js";

const loaded = {
  skills: [{ name: "referenced-skill" }, { name: "missing-skill" }],
  mcpServers: [{ name: "referenced" }, { name: "missing" }],
};

for (const expected of [null, -1, 1.5, "unknown", 1]) {
  it(`capture count ${expected} without matching calls cannot certify absence`, async (t) => {
    const { db } = await captureFixture(t);
    addMessage(db, "incomplete");
    db.prepare("UPDATE messages SET tool_capture_count = ?").run(expected);
    const capture = scanToolCapture(db);
    assert.deepEqual(capture, {
      complete: false,
      observedMessages: 1,
      incompleteMessages: 1,
      orphanToolCalls: 0,
    });
    const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture);
    assert.ok(report.findings.every((finding) => finding.verdict === "unknown"));
    assert.deepEqual(report.pruneCandidates, []);
  });
}

it("version1 without a supported count column cannot certify coverage in a partial schema18 store", async (t) => {
  const { db } = await captureFixture(t);
  addMessage(db, "partial", 1, "session", 1);
  addCall(db, "partial", "mcp__referenced__tool");
  db.exec("ALTER TABLE messages DROP COLUMN tool_capture_count; PRAGMA query_only = ON");
  assert.equal(db.prepare("SELECT version FROM schema_meta").get()?.version, 18);
  const capture = scanToolCapture(db);
  assert.deepEqual(capture, {
    complete: false,
    observedMessages: 1,
    incompleteMessages: 1,
    orphanToolCalls: 0,
  });
  const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture);
  assert.equal(report.findings.find((finding) => finding.name === "referenced")?.verdict, "used");
  assert.deepEqual(report.pruneCandidates, []);
});

for (const expected of [0, 2]) {
  it(`one matched row with expected count ${expected} leaves missing references unknown`, async (t) => {
    const { db } = await captureFixture(t);
    addMessage(db, "mismatch", 1, "session", expected);
    addCall(db, "mismatch", "mcp__referenced__tool");
    const capture = scanToolCapture(db);
    assert.equal(capture.complete, false);
    assert.equal(capture.incompleteMessages, 1);
    const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture);
    assert.equal(report.findings.find((finding) => finding.name === "referenced")?.verdict, "used");
    assert.deepEqual(report.pruneCandidates, []);
  });
}

for (const version of [0, 2, -1, 1.5]) {
  it(`a message with unsupported capture version ${version} prevents negative evidence even without tool rows`, async (t) => {
    const { db } = await captureFixture(t);
    addMessage(db, "complete", 1, "session", 1);
    addMessage(db, "incomplete", version);
    addCall(db, "complete", "mcp__referenced__tool");
    const capture = scanToolCapture(db);
    assert.deepEqual(capture, {
      complete: false,
      observedMessages: 2,
      incompleteMessages: 1,
      orphanToolCalls: 0,
    });
    const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture);
    assert.equal(report.findings.find((finding) => finding.name === "referenced")?.verdict, "used");
    assert.ok(
      report.findings
        .filter((finding) => finding.refs === 0)
        .every((finding) => finding.verdict === "unknown"),
    );
    assert.deepEqual(report.pruneCandidates, []);
  });
}

it("null capture versions remain incomplete when reading an older nullable column", async (t) => {
  const { db } = await captureFixture(t);
  db.exec(
    "ALTER TABLE messages DROP COLUMN tool_capture_version; ALTER TABLE messages ADD COLUMN tool_capture_version INTEGER DEFAULT 0",
  );
  db.exec(
    "INSERT INTO messages (uuid, session_id, type, tool_capture_version) VALUES ('nullable', 'session', 'assistant', NULL)",
  );
  db.exec("PRAGMA query_only = ON");
  assert.deepEqual(scanToolCapture(db), {
    complete: false,
    observedMessages: 1,
    incompleteMessages: 1,
    orphanToolCalls: 0,
  });
});

it("no observed messages cannot establish coverage even when orphan tool rows exist", async (t) => {
  const { db } = await captureFixture(t);
  assert.deepEqual(scanToolCapture(db), {
    complete: false,
    observedMessages: 0,
    incompleteMessages: 0,
    orphanToolCalls: 0,
  });
  addCall(db, "unobserved", "mcp__referenced__tool");
  const capture = scanToolCapture(db);
  assert.deepEqual(capture, {
    complete: false,
    observedMessages: 0,
    incompleteMessages: 0,
    orphanToolCalls: 1,
  });
  assert.deepEqual(
    computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture).pruneCandidates,
    [],
  );
});

it("a call linked to a different message session is not coverage evidence", async (t) => {
  const { db } = await captureFixture(t);
  addMessage(db, "message", 1, "other-session", 1);
  addCall(db, "message", "mcp__referenced__tool");
  assert.deepEqual(scanToolCapture(db), {
    complete: false,
    observedMessages: 1,
    incompleteMessages: 1,
    orphanToolCalls: 1,
  });
});

it("matching total counts cannot conceal missing calls from one message", async (t) => {
  const { db } = await captureFixture(t);
  addMessage(db, "missing", 1, "session", 1);
  addMessage(db, "extra", 1, "session", 1);
  addCall(db, "extra", "mcp__referenced__tool");
  addCall(db, "extra", "Read");
  assert.deepEqual(scanToolCapture(db), {
    complete: false,
    observedMessages: 2,
    incompleteMessages: 2,
    orphanToolCalls: 0,
  });
});

it("all native call outcomes retain positive MCP and explicit Skill references", async (t) => {
  const { db } = await captureFixture(t);
  for (const outcome of ["unknown", "returned", "error", "denied", "conflict"]) {
    addMessage(db, outcome, 1, "session", 2);
    addCall(db, outcome, "mcp__referenced__tool", "{}", outcome);
    addCall(db, outcome, "Skill", '{"skill":"referenced-skill"}', outcome);
  }
  const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), scanToolCapture(db));
  for (const name of ["referenced", "referenced-skill"]) {
    const finding = report.findings.find((entry) => entry.name === name);
    assert.equal(finding?.verdict, "used");
    assert.equal(finding?.refs, 5);
  }
});

for (const wrapper of ["exec", "functions.exec", "parallel", "multi_tool_use.parallel"]) {
  it(`incomplete ${wrapper} capture does not imply absent nested MCP or skill references`, async (t) => {
    const { db } = await captureFixture(t);
    addMessage(db, "opaque", 0);
    addCall(
      db,
      "opaque",
      wrapper,
      '{"code":"await tools.mcp__missing__search()","skill":"missing-skill"}',
      "returned",
    );
    const capture = scanToolCapture(db);
    assert.equal(capture.complete, false);
    const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture);
    assert.ok(
      report.findings.every((finding) => finding.verdict === "unknown" && finding.refs === 0),
    );
    assert.deepEqual(report.pruneCandidates, []);
  });
}

it("complete message capture permits negative evidence, including messages without calls", async (t) => {
  const { db } = await captureFixture(t);
  addMessage(db, "observed", 1, "session", 2);
  addMessage(db, "no-tools");
  addCall(db, "observed", "mcp__referenced__tool");
  addCall(db, "observed", "Skill", '{"skill":"referenced-skill"}');
  db.exec("PRAGMA query_only = ON");
  const capture = scanToolCapture(db);
  assert.deepEqual(capture, {
    complete: true,
    observedMessages: 2,
    incompleteMessages: 0,
    orphanToolCalls: 0,
  });
  const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture);
  assert.equal(report.findings.find((finding) => finding.name === "referenced")?.verdict, "used");
  assert.equal(
    report.findings.find((finding) => finding.name === "referenced-skill")?.verdict,
    "used",
  );
  assert.equal(
    report.findings.find((finding) => finding.name === "missing-skill")?.verdict,
    "unknown",
  );
  assert.deepEqual(report.pruneCandidates, ["missing"]);
});

it("complete Codex native capture cannot establish unused skills from absent Skill calls", async (t) => {
  const { db } = await captureFixture(t);
  db.prepare("INSERT INTO sessions (session_id, harness) VALUES ('session', 'codex')").run();
  addMessage(db, "codex", 1, "session", 2);
  addCall(db, "codex", "Read", '{"file_path":".claude/skills/missing-skill/SKILL.md"}', "returned");
  addCall(db, "codex", "mcp__referenced__tool", "{}", "returned");
  const capture = scanToolCapture(db);
  assert.equal(capture.complete, true);
  const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture);
  assert.ok(
    report.findings
      .filter((finding) => finding.kind === "skill")
      .every((finding) => finding.verdict === "unknown"),
  );
  assert.deepEqual(report.pruneCandidates, ["missing"]);
  assert.equal(report.skillCoverage, "explicit-references-only");
});

it("an orphan call prevents complete coverage even when observed messages have version 1", async (t) => {
  const { db } = await captureFixture(t);
  addMessage(db, "captured");
  addCall(db, "missing-message", "mcp__referenced__tool");
  const capture = scanToolCapture(db);
  assert.deepEqual(capture, {
    complete: false,
    observedMessages: 1,
    incompleteMessages: 0,
    orphanToolCalls: 1,
  });
  const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture);
  assert.equal(report.findings.find((finding) => finding.name === "referenced")?.verdict, "used");
  assert.ok(
    report.findings
      .filter((finding) => finding.refs === 0)
      .every((finding) => finding.verdict === "unknown"),
  );
  assert.deepEqual(report.pruneCandidates, []);
});

it("a read-only schema17 store supplies positive references but no negative evidence", async (t) => {
  const { db } = await captureFixture(t);
  addMessage(db, "legacy", 1, "session", 2);
  addCall(db, "legacy", "mcp__referenced__tool", "{}", "error");
  addCall(db, "legacy", "Skill", '{"skill":"referenced-skill"}', "denied");
  db.exec(
    "ALTER TABLE messages DROP COLUMN tool_capture_version; UPDATE schema_meta SET version = 17; PRAGMA query_only = ON",
  );
  const capture = scanToolCapture(db);
  assert.deepEqual(capture, {
    complete: false,
    observedMessages: 1,
    incompleteMessages: 1,
    orphanToolCalls: 0,
  });
  const report = computeUnused(loaded, scanToolUsage(db), scanSkillUsage(db), capture);
  assert.equal(report.findings.find((finding) => finding.name === "referenced")?.verdict, "used");
  assert.equal(
    report.findings.find((finding) => finding.name === "referenced-skill")?.verdict,
    "used",
  );
  assert.ok(
    report.findings
      .filter((finding) => finding.refs === 0)
      .every((finding) => finding.verdict === "unknown"),
  );
  assert.deepEqual(report.pruneCandidates, []);
  assert.equal(db.prepare("SELECT version FROM schema_meta").get()?.version, 17);
});
