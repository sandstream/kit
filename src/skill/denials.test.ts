import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGateDenials, denialActionsForSkill, type GateDenial } from "./denials.js";
import type { SpanWindow } from "./attribute.js";

const denyLine = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    timestamp: "2026-07-17T12:00:00Z",
    operation: "gate-egress",
    success: false,
    error: "off-scope",
    metadata: { phase: "pretooluse-deny", session_id: "s1" },
    ...over,
  });

describe("parseGateDenials", () => {
  it("keeps gate-egress/gate-fs pretooluse denies with a session_id", () => {
    const jsonl = [denyLine(), denyLine({ operation: "gate-fs" })].join("\n");
    const out = parseGateDenials(jsonl);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((d) => d.gate),
      ["gate-egress", "gate-fs"],
    );
    assert.equal(out[0].sessionId, "s1");
  });

  it("drops non-gate ops, successes, non-pretooluse, and session-less denies", () => {
    const jsonl = [
      denyLine({ operation: "secrets.get" }), // not a gate
      denyLine({ success: true }), // not a deny
      denyLine({ metadata: { phase: "other", session_id: "s1" } }), // not pretooluse
      denyLine({ metadata: { phase: "pretooluse-deny" } }), // no session_id join key
    ].join("\n");
    assert.deepEqual(parseGateDenials(jsonl), []);
  });

  it("tolerates blank and malformed lines (never throws)", () => {
    const jsonl = ["", "not json", "{", denyLine()].join("\n");
    assert.equal(parseGateDenials(jsonl).length, 1);
  });

  it("empty input → no denials", () => {
    assert.deepEqual(parseGateDenials(""), []);
  });
});

describe("denialActionsForSkill", () => {
  const windows: SpanWindow[] = [
    { sessionId: "s1", start: "2026-07-17T12:00:00Z", end: "2026-07-17T12:10:00Z" },
    { sessionId: "s2", start: "2026-07-17T13:00:00Z", end: "" }, // open-ended
  ];
  const deny = (sessionId: string, timestamp: string, gate = "gate-egress"): GateDenial => ({
    sessionId,
    timestamp,
    gate,
  });

  it("attributes a deny inside a matching session window as a denied out-of-scope action", () => {
    const actions = denialActionsForSkill(windows, [deny("s1", "2026-07-17T12:05:00Z")]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].denied, true);
    assert.equal(actions[0].brokerVerdict, "out-of-scope");
    assert.equal(actions[0].tool, "gate-egress");
  });

  it("ignores a deny in the right session but outside the window", () => {
    assert.deepEqual(denialActionsForSkill(windows, [deny("s1", "2026-07-17T12:20:00Z")]), []);
  });

  it("ignores a deny whose session does not match any window", () => {
    assert.deepEqual(denialActionsForSkill(windows, [deny("sX", "2026-07-17T12:05:00Z")]), []);
  });

  it("an open-ended window attributes any later deny in that session", () => {
    const actions = denialActionsForSkill(windows, [deny("s2", "2026-07-17T20:00:00Z", "gate-fs")]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].tool, "gate-fs");
  });

  it("the window start is inclusive, the end exclusive", () => {
    assert.equal(denialActionsForSkill(windows, [deny("s1", "2026-07-17T12:00:00Z")]).length, 1);
    assert.equal(denialActionsForSkill(windows, [deny("s1", "2026-07-17T12:10:00Z")]).length, 0);
  });
});
