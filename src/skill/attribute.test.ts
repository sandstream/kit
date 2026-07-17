import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkillOpen, attributeRuns, type ToolCallRow } from "./attribute.js";

describe("parseSkillOpen", () => {
  it("returns the slug for a Skill call", () => {
    assert.equal(parseSkillOpen("Skill", '{"skill":"triage"}'), "triage");
  });
  it("returns null for a non-Skill tool", () => {
    assert.equal(parseSkillOpen("Bash", '{"skill":"triage"}'), null);
  });
  it("returns null for blank/unparseable/missing input", () => {
    assert.equal(parseSkillOpen("Skill", null), null);
    assert.equal(parseSkillOpen("Skill", "not json"), null);
    assert.equal(parseSkillOpen("Skill", "{}"), null);
    assert.equal(parseSkillOpen("Skill", '{"skill":"   "}'), null);
  });
});

const row = (sessionId: string, tool: string, opensSkill: string | null = null): ToolCallRow => ({
  sessionId,
  tool,
  opensSkill,
});

describe("attributeRuns", () => {
  it("attributes the calls inside a target span, excluding the Skill row itself", () => {
    const rows: ToolCallRow[] = [
      row("s1", "Read"), // before any skill — ignored
      row("s1", "Skill", "run-tests"), // opens span
      row("s1", "Bash"),
      row("s1", "Grep"),
    ];
    const ev = attributeRuns(rows, "run-tests");
    assert.equal(ev.runs, 1);
    assert.equal(ev.sessions, 1);
    assert.deepEqual(
      ev.actions.map((a) => a.tool),
      ["Bash", "Grep"],
    );
    assert.equal(ev.confidence, "span");
  });

  it("closes the span when another skill opens", () => {
    const rows: ToolCallRow[] = [
      row("s1", "Skill", "run-tests"),
      row("s1", "Bash"),
      row("s1", "Skill", "deploy"), // closes run-tests span
      row("s1", "WebFetch"), // belongs to deploy, not run-tests
    ];
    const ev = attributeRuns(rows, "run-tests");
    assert.deepEqual(
      ev.actions.map((a) => a.tool),
      ["Bash"],
    );
    assert.equal(ev.runs, 1);
  });

  it("resets the active span at a session boundary", () => {
    const rows: ToolCallRow[] = [
      row("s1", "Skill", "run-tests"),
      row("s1", "Bash"),
      row("s2", "Grep"), // new session, no active span → not attributed
    ];
    const ev = attributeRuns(rows, "run-tests");
    assert.deepEqual(
      ev.actions.map((a) => a.tool),
      ["Bash"],
    );
    assert.equal(ev.sessions, 1);
  });

  it("counts runs across sessions and multiple invocations", () => {
    const rows: ToolCallRow[] = [
      row("s1", "Skill", "run-tests"),
      row("s1", "Bash"),
      row("s1", "Skill", "run-tests"), // second run, same session
      row("s1", "Read"),
      row("s2", "Skill", "run-tests"), // third run, new session
      row("s2", "Grep"),
    ];
    const ev = attributeRuns(rows, "run-tests");
    assert.equal(ev.runs, 3);
    assert.equal(ev.sessions, 2);
    assert.deepEqual(
      ev.actions.map((a) => a.tool),
      ["Bash", "Read", "Grep"],
    );
  });

  it("returns zero runs when the target skill never opened a span", () => {
    const rows: ToolCallRow[] = [row("s1", "Skill", "other"), row("s1", "Bash")];
    const ev = attributeRuns(rows, "run-tests");
    assert.equal(ev.runs, 0);
    assert.equal(ev.actions.length, 0);
  });

  it("marks every attributed action as not-denied (transcript records runs)", () => {
    const rows: ToolCallRow[] = [row("s1", "Skill", "x"), row("s1", "Bash")];
    const ev = attributeRuns(rows, "x");
    assert.equal(ev.actions[0].denied, false);
  });
});
