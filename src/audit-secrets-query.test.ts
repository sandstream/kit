import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent } from "./audit.js";
import { answerKeyAccess, COVERAGE } from "./audit-secrets-query.js";

const SINCE = "2026-11-01T00:00:00Z";

// Names and metadata only: audit events never carry a value.
const EVENTS: AuditEvent[] = [
  ev("secrets.read", "2026-10-30T09:00:00Z", { name: "DEMO_PIN", store: "aws-sm", via: "kit run" }),
  ev("secrets.read", "2026-11-02T09:00:00Z", {
    names: ["DEMO_PIN", "OTHER"],
    store: "aws-sm",
    via: "kit secrets",
    harness: "Codex",
  }),
  ev("secrets.rotate", "2026-11-03T09:00:00Z", { name: "DEMO_PIN", target: "aws-sm" }),
  ev("secrets.read", "2026-11-04T09:00:00Z", { name: "OTHER", store: "env", via: "kit run" }),
  ev("secrets.generate", "2026-11-05T09:00:00Z", { store: "env" }),
  ev("check", "2026-11-05T10:00:00Z", { name: "DEMO_PIN" }),
];

function ev(operation: string, timestamp: string, metadata: Record<string, unknown>): AuditEvent {
  return { timestamp, operation, environment: "dev", success: true, metadata };
}

describe("answerKeyAccess", () => {
  const content = EVENTS.map((e) => JSON.stringify(e)).join("\n");

  it("lists the key's reads and writes since T, oldest first, with who and where", () => {
    const a = answerKeyAccess(content, "DEMO_PIN", new Date(SINCE));
    assert.deepEqual(a.events, [
      {
        timestamp: "2026-11-02T09:00:00Z",
        kind: "read",
        operation: "secrets.read",
        success: true,
        harness: "Codex",
        via: "kit secrets",
        store: "aws-sm",
      },
      {
        timestamp: "2026-11-03T09:00:00Z",
        kind: "write",
        operation: "secrets.rotate",
        success: true,
        target: "aws-sm",
      },
    ]);
    assert.deepEqual([a.reads, a.writes], [1, 1]);
  });

  it("counts the events that name no key, and states its coverage", () => {
    const a = answerKeyAccess(content, "DEMO_PIN", new Date(SINCE));
    assert.equal(a.unattributed, 1);
    assert.equal(a.coverage, COVERAGE);
    assert.match(a.coverage, /reads through kit only; processes that read \.env\.local directly/);
  });
});
