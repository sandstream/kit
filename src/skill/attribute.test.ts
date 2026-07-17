import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSkillOpen,
  attributeRuns,
  brokerVerdictForRow,
  type ToolCallRow,
} from "./attribute.js";
import type { BrokerPolicy } from "../exec-broker/policy.js";

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
  input: null,
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

  it("threads a broker verdict onto attributed actions via verdictOf", () => {
    const rows: ToolCallRow[] = [row("s1", "Skill", "x"), row("s1", "WebFetch")];
    const ev = attributeRuns(rows, "x", (r) =>
      r.tool === "WebFetch" ? "out-of-scope" : undefined,
    );
    assert.equal(ev.actions[0].brokerVerdict, "out-of-scope");
  });
});

const policy: BrokerPolicy = {
  egress: { allow: ["api.example.com", ".trusted.dev"] },
  fs: { root: "/repo", roots: ["/repo/extra"] },
  env: { declared: [] },
};

describe("brokerVerdictForRow", () => {
  it("Bash: in-scope when every extracted host is allowed, out-of-scope otherwise", () => {
    assert.equal(
      brokerVerdictForRow(
        "Bash",
        JSON.stringify({ command: "curl https://api.example.com/x" }),
        policy,
      ),
      "in-scope",
    );
    assert.equal(
      brokerVerdictForRow("Bash", JSON.stringify({ command: "curl https://evil.com/x" }), policy),
      "out-of-scope",
    );
  });

  it("Bash: no extractable host → undefined (tool-scope still applies)", () => {
    assert.equal(
      brokerVerdictForRow("Bash", JSON.stringify({ command: "ls -la" }), policy),
      undefined,
    );
  });

  it("WebFetch: url checked against the egress allowlist (suffix match honored)", () => {
    assert.equal(
      brokerVerdictForRow("WebFetch", JSON.stringify({ url: "https://sub.trusted.dev/a" }), policy),
      "in-scope",
    );
    assert.equal(
      brokerVerdictForRow("WebFetch", JSON.stringify({ url: "https://elsewhere.net" }), policy),
      "out-of-scope",
    );
  });

  it("Write/Edit: file_path must land under an allowed fs root", () => {
    assert.equal(
      brokerVerdictForRow("Write", JSON.stringify({ file_path: "/repo/src/a.ts" }), policy),
      "in-scope",
    );
    assert.equal(
      brokerVerdictForRow("Edit", JSON.stringify({ file_path: "/repo/extra/b.ts" }), policy),
      "in-scope",
    );
    assert.equal(
      brokerVerdictForRow("Write", JSON.stringify({ file_path: "/etc/passwd" }), policy),
      "out-of-scope",
    );
  });

  it("non-egress/fs tools and unparseable/absent input → undefined", () => {
    assert.equal(
      brokerVerdictForRow("Read", JSON.stringify({ file_path: "/x" }), policy),
      undefined,
    );
    assert.equal(brokerVerdictForRow("Bash", null, policy), undefined);
    assert.equal(brokerVerdictForRow("Bash", "not json", policy), undefined);
  });
});
