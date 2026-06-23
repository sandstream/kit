import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecretAuditEvents, groupBySecret, summarize } from "./audit-secrets.js";

function makeRepo(events: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-audit-"));
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, ".kit-audit.jsonl"), text);
  return dir;
}

describe("readSecretAuditEvents", () => {
  it("returns [] when audit log is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-audit-"));
    try {
      const events = await readSecretAuditEvents(dir);
      assert.equal(events.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters to secret-related operations only", async () => {
    const dir = makeRepo([
      {
        timestamp: new Date().toISOString(),
        operation: "secrets.generate",
        environment: "dev",
        success: true,
      },
      {
        timestamp: new Date().toISOString(),
        operation: "non.secret.op",
        environment: "dev",
        success: true,
      },
      {
        timestamp: new Date().toISOString(),
        operation: "secrets.rotate",
        environment: "dev",
        success: true,
      },
    ]);
    try {
      const events = await readSecretAuditEvents(dir);
      assert.equal(events.length, 2);
      assert.ok(events.every((e) => e.operation.startsWith("secrets.")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters out events older than sinceDays", async () => {
    const old = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    const recent = new Date().toISOString();
    const dir = makeRepo([
      { timestamp: old, operation: "secrets.generate", environment: "dev", success: true },
      { timestamp: recent, operation: "secrets.generate", environment: "dev", success: true },
    ]);
    try {
      const events = await readSecretAuditEvents(dir, 30);
      assert.equal(events.length, 1);
      assert.equal(events[0].timestamp, recent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed lines silently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-audit-"));
    try {
      writeFileSync(
        join(dir, ".kit-audit.jsonl"),
        `{"timestamp":"${new Date().toISOString()}","operation":"secrets.rotate","environment":"dev","success":true}\nnot-json-at-all\n{"x":"missing op"}\n`,
      );
      const events = await readSecretAuditEvents(dir);
      assert.equal(events.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("groupBySecret", () => {
  it("attributes events with metadata.key", () => {
    const events = [
      {
        timestamp: "2026-06-01T10:00:00Z",
        operation: "secrets.rotate",
        environment: "dev",
        success: true,
        metadata: { key: "STRIPE_SECRET_KEY" },
      },
      {
        timestamp: "2026-06-02T10:00:00Z",
        operation: "secrets.onecli.register",
        environment: "dev",
        success: true,
        metadata: { name: "STRIPE_SECRET_KEY" },
      },
      {
        timestamp: "2026-06-03T10:00:00Z",
        operation: "secrets.migrate",
        environment: "dev",
        success: true,
        metadata: { keys: ["RESEND_API_KEY"] },
      },
    ];
    const { reports, unattributed } = groupBySecret(events);
    assert.equal(reports.length, 2);
    const stripe = reports.find((r) => r.key === "STRIPE_SECRET_KEY");
    assert.equal(stripe?.events.length, 2);
    assert.equal(unattributed.length, 0);
  });

  it("buckets events without metadata-key into unattributed", () => {
    const events = [
      {
        timestamp: "2026-06-01T10:00:00Z",
        operation: "secrets.generate",
        environment: "dev",
        success: true,
        metadata: { store: "1password" },
      },
    ];
    const { reports, unattributed } = groupBySecret(events);
    assert.equal(reports.length, 0);
    assert.equal(unattributed.length, 1);
  });
});

describe("summarize", () => {
  it("counts events + identifies the top key", () => {
    const reports = [
      {
        key: "STRIPE_SECRET_KEY",
        events: Array(5).fill({
          timestamp: "2026-06-01T10:00:00Z",
          operation: "x",
          detail: "",
          success: true,
        }),
      },
      {
        key: "OPENAI_API_KEY",
        events: Array(2).fill({
          timestamp: "2026-06-01T10:00:00Z",
          operation: "x",
          detail: "",
          success: true,
        }),
      },
    ];
    const s = summarize(reports, 30);
    assert.equal(s.totalEvents, 7);
    assert.equal(s.keyCount, 2);
    assert.equal(s.topKey?.key, "STRIPE_SECRET_KEY");
    assert.equal(s.topKey?.count, 5);
    assert.equal(s.windowDays, 30);
  });

  it("handles empty input cleanly", () => {
    const s = summarize([], 30);
    assert.equal(s.totalEvents, 0);
    assert.equal(s.keyCount, 0);
    assert.equal(s.topKey, undefined);
  });
});
