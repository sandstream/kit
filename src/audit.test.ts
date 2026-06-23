import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  logAuditEvent,
  readAuditLog,
  formatAuditLog,
  appendAuditEventDirect,
  verifyAuditChain,
} from "./audit.js";
import type { GovernanceConfig } from "./config.js";

describe("logAuditEvent", () => {
  const testLogFile = join(tmpdir(), `.kit-audit-test-${process.pid}.jsonl`);

  afterEach(async () => {
    try {
      await unlink(testLogFile);
    } catch {
      /* ignore */
    }
  });

  it("skips logging when audit is disabled", async () => {
    const config: Required<GovernanceConfig> = {
      enabled: true,
      environment: "dev",
      access: { dev: { read: true, write: true, delete: true } },
      agent: { id: "test-agent", name: "Test Agent" },
      audit: { enabled: false, log_file: testLogFile },
      approval: {},
      secrets: {},
      revocation: {},
    };

    await logAuditEvent(config, {
      operation: "test",
      environment: "dev",
      success: true,
    });

    // File should not be created
    try {
      await readFile(testLogFile, "utf-8");
      assert.fail("Log file should not have been created");
    } catch (error: any) {
      assert.equal(error.code, "ENOENT");
    }
  });

  it("logs audit event to file when enabled", async () => {
    const config: Required<GovernanceConfig> = {
      enabled: true,
      environment: "dev",
      access: { dev: { read: true, write: true, delete: true } },
      agent: { id: "test-agent", name: "Test Agent" },
      audit: {
        enabled: true,
        log_file: testLogFile,
        include_secrets: false,
      },
      approval: {},
      secrets: {},
      revocation: {},
    };

    await logAuditEvent(config, {
      operation: "check",
      environment: "dev",
      success: true,
      duration_ms: 123,
    });

    const content = await readFile(testLogFile, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 1);

    const event = JSON.parse(lines[0]);
    assert.equal(event.operation, "check");
    assert.equal(event.environment, "dev");
    assert.equal(event.success, true);
    assert.equal(event.duration_ms, 123);
    assert.equal(event.agent_id, "test-agent");
    assert.equal(event.agent_name, "Test Agent");
    assert.ok(event.timestamp);
  });

  it("redacts secrets from metadata when include_secrets is false", async () => {
    const config: Required<GovernanceConfig> = {
      enabled: true,
      environment: "prod",
      access: { prod: { read: true, write: false, delete: false } },
      agent: { id: "agent-1", name: "Agent 1" },
      audit: {
        enabled: true,
        log_file: testLogFile,
        include_secrets: false,
      },
      approval: {},
      secrets: {},
      revocation: {},
    };

    await logAuditEvent(config, {
      operation: "secrets.generate",
      environment: "prod",
      success: true,
      metadata: {
        api_key: "super-secret-key",
        password: "my-password",
        database_url: "postgres://localhost/db",
        count: 5,
      },
    });

    const content = await readFile(testLogFile, "utf-8");
    const event = JSON.parse(content.trim());

    assert.equal(event.metadata.api_key, "[REDACTED]");
    assert.equal(event.metadata.password, "[REDACTED]");
    assert.equal(event.metadata.database_url, "postgres://localhost/db");
    assert.equal(event.metadata.count, 5);
  });

  it("keeps secrets in metadata when include_secrets is true", async () => {
    const config: Required<GovernanceConfig> = {
      enabled: true,
      environment: "dev",
      access: { dev: { read: true, write: true, delete: true } },
      agent: { id: "agent-1", name: "Agent 1" },
      audit: {
        enabled: true,
        log_file: testLogFile,
        include_secrets: true,
      },
      approval: {},
      secrets: {},
      revocation: {},
    };

    await logAuditEvent(config, {
      operation: "secrets.generate",
      environment: "dev",
      success: true,
      metadata: {
        api_key: "super-secret-key",
        password: "my-password",
      },
    });

    const content = await readFile(testLogFile, "utf-8");
    const event = JSON.parse(content.trim());

    assert.equal(event.metadata.api_key, "super-secret-key");
    assert.equal(event.metadata.password, "my-password");
  });

  it("logs multiple events in sequence", async () => {
    const config: Required<GovernanceConfig> = {
      enabled: true,
      environment: "staging",
      access: { staging: { read: true, write: true, delete: false } },
      agent: { id: "agent-2", name: "Agent 2" },
      audit: {
        enabled: true,
        log_file: testLogFile,
        include_secrets: false,
      },
      approval: {},
      secrets: {},
      revocation: {},
    };

    await logAuditEvent(config, {
      operation: "check",
      environment: "staging",
      success: true,
    });

    await logAuditEvent(config, {
      operation: "login",
      environment: "staging",
      success: true,
    });

    await logAuditEvent(config, {
      operation: "secrets",
      environment: "staging",
      success: false,
      error: "Missing secrets",
    });

    const content = await readFile(testLogFile, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 3);

    const events = lines.map((line) => JSON.parse(line));
    assert.equal(events[0].operation, "check");
    assert.equal(events[1].operation, "login");
    assert.equal(events[2].operation, "secrets");
    assert.equal(events[2].success, false);
    assert.equal(events[2].error, "Missing secrets");
  });
});

describe("readAuditLog", () => {
  const testLogFile = join(tmpdir(), `.kit-audit-read-${process.pid}.jsonl`);

  afterEach(async () => {
    try {
      await unlink(testLogFile);
    } catch {
      /* ignore */
    }
  });

  it("returns empty array when log file does not exist", async () => {
    const events = await readAuditLog(testLogFile);
    assert.deepEqual(events, []);
  });

  it("reads audit log entries", async () => {
    const config: Required<GovernanceConfig> = {
      enabled: true,
      environment: "dev",
      access: { dev: { read: true, write: true, delete: true } },
      agent: { id: "test-agent", name: "Test Agent" },
      audit: {
        enabled: true,
        log_file: testLogFile,
        include_secrets: false,
      },
      approval: {},
      secrets: {},
      revocation: {},
    };

    // Write some events
    await logAuditEvent(config, {
      operation: "check",
      environment: "dev",
      success: true,
    });
    await logAuditEvent(config, {
      operation: "secrets",
      environment: "dev",
      success: true,
    });

    const events = await readAuditLog(testLogFile);
    assert.equal(events.length, 2);
    assert.equal(events[0].operation, "check");
    assert.equal(events[1].operation, "secrets");
  });

  it("limits number of entries returned", async () => {
    const config: Required<GovernanceConfig> = {
      enabled: true,
      environment: "dev",
      access: { dev: { read: true, write: true, delete: true } },
      agent: { id: "test-agent", name: "Test Agent" },
      audit: {
        enabled: true,
        log_file: testLogFile,
        include_secrets: false,
      },
      approval: {},
      secrets: {},
      revocation: {},
    };

    // Write multiple events
    for (let i = 0; i < 10; i++) {
      await logAuditEvent(config, {
        operation: `operation-${i}`,
        environment: "dev",
        success: true,
      });
    }

    const events = await readAuditLog(testLogFile, 5);
    assert.equal(events.length, 5);
    // Should return last 5 entries
    assert.equal(events[0].operation, "operation-5");
    assert.equal(events[4].operation, "operation-9");
  });
});

describe("formatAuditLog", () => {
  it("returns message when no events", () => {
    const formatted = formatAuditLog([]);
    assert.equal(formatted, "No audit log entries found.");
  });

  it("formats single event", () => {
    const events = [
      {
        timestamp: "2026-03-30T10:00:00.000Z",
        agent_id: "agent-1",
        agent_name: "Agent 1",
        operation: "check",
        environment: "dev",
        success: true,
        duration_ms: 123,
      },
    ];

    const formatted = formatAuditLog(events);
    assert.ok(formatted.includes("✓"));
    assert.ok(formatted.includes("check"));
    assert.ok(formatted.includes("(123ms)"));
    assert.ok(formatted.includes("[dev]"));
    assert.ok(formatted.includes("Agent 1"));
  });

  it("formats event with error", () => {
    const events = [
      {
        timestamp: "2026-03-30T10:00:00.000Z",
        agent_id: "agent-1",
        agent_name: "Agent 1",
        operation: "secrets",
        environment: "prod",
        success: false,
        error: "Missing API key",
      },
    ];

    const formatted = formatAuditLog(events);
    assert.ok(formatted.includes("✗"));
    assert.ok(formatted.includes("secrets"));
    assert.ok(formatted.includes("[prod]"));
    assert.ok(formatted.includes("Error: Missing API key"));
  });
});

describe("verifyAuditChain (tamper-evidence)", () => {
  async function writeEvents(dir: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const ok = await appendAuditEventDirect(
        { operation: `op-${i}`, environment: "dev", success: true },
        { cwd: dir },
      );
      assert.equal(ok, true);
    }
  }

  it("accepts an empty log", () => {
    assert.deepEqual(verifyAuditChain(""), { ok: true, entries: 0 });
  });

  it("verifies a chain produced by appendAuditEventDirect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-audit-c-"));
    try {
      await writeEvents(dir, 4);
      const r = verifyAuditChain(readFileSync(join(dir, ".kit-audit.jsonl"), "utf8"));
      assert.equal(r.ok, true);
      assert.equal(r.entries, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects tampered content (hash mismatch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-audit-t-"));
    try {
      await writeEvents(dir, 3);
      const lines = readFileSync(join(dir, ".kit-audit.jsonl"), "utf8").trim().split("\n");
      const mid = JSON.parse(lines[1]);
      mid.operation = "tampered-after-the-fact";
      lines[1] = JSON.stringify(mid);
      const r = verifyAuditChain(lines.join("\n") + "\n");
      assert.equal(r.ok, false);
      assert.equal(r.brokenAt, 1);
      assert.match(r.reason!, /tampered/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a deleted entry (broken prev-link)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-audit-d-"));
    try {
      await writeEvents(dir, 4);
      const lines = readFileSync(join(dir, ".kit-audit.jsonl"), "utf8").trim().split("\n");
      lines.splice(1, 1);
      const r = verifyAuditChain(lines.join("\n") + "\n");
      assert.equal(r.ok, false);
      assert.equal(r.brokenAt, 1);
      assert.match(r.reason!, /inserted, removed, or reordered/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags an unchained (legacy) entry", () => {
    const legacy = JSON.stringify({
      timestamp: "t",
      operation: "x",
      environment: "dev",
      success: true,
    });
    const r = verifyAuditChain(legacy + "\n");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /missing hash/);
  });
});
