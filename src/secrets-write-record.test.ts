import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordSecretWrite,
  SECRET_WRITE_OPS,
  secretWriteEvent,
  type SecretWriteOp,
} from "./secrets-write-record.js";
import { groupBySecret, readSecretAuditEvents } from "./audit-secrets.js";
import { failedKeyNames } from "./secrets-sync.js";
import { propagate } from "./secrets-propagate.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("secretWriteEvent", () => {
  it("names the key and the target, and carries no value or error text", () => {
    const e = secretWriteEvent(
      SECRET_WRITE_OPS.propagate,
      { keys: ["STRIPE_SECRET_KEY"], target: "railway", ok: false },
      { KIT_ENV: "prod" },
    );
    assert.deepEqual(e, {
      operation: "secrets.propagate",
      environment: "prod",
      success: false,
      metadata: { name: "STRIPE_SECRET_KEY", target: "railway" },
    });
  });

  it("lists several keys once each", () => {
    const e = secretWriteEvent(SECRET_WRITE_OPS.sync, {
      keys: ["A", "B", "A"],
      target: ".env.ci",
      ok: true,
    });
    assert.deepEqual(e.metadata, { names: ["A", "B"], target: ".env.ci" });
  });
});

describe("recordSecretWrite → audit-secrets (writer and reader together)", () => {
  it("every write operation is read back by the forensics view, grouped by key", async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-secret-write-"));
    t.after(() => rmTemp(cwd));
    const ops = Object.values(SECRET_WRITE_OPS) as SecretWriteOp[];
    for (const op of ops)
      await recordSecretWrite(op, { keys: ["DB_URL"], target: "railway", ok: true }, { cwd });

    const events = await readSecretAuditEvents(cwd, 1);
    assert.deepEqual(
      events.map((e) => e.operation).sort(),
      [...ops].sort(),
      "the view must read every operation the writers emit",
    );
    const { reports, unattributed } = groupBySecret(events);
    assert.equal(unattributed.length, 0);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].key, "DB_URL");
    assert.ok(reports[0].events.every((e) => e.detail.includes("target=railway")));
  });

  it("groups a several-key write under each name, as the audit log stores it", async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-secret-write-"));
    t.after(() => rmTemp(cwd));
    await recordSecretWrite(
      SECRET_WRITE_OPS.sync,
      { keys: ["STRIPE_SECRET_KEY", "GITHUB_TOKEN"], target: "github", ok: true },
      { cwd },
    );
    const { reports } = groupBySecret(await readSecretAuditEvents(cwd, 1));
    assert.deepEqual(reports.map((r) => r.key).sort(), ["GITHUB_TOKEN", "STRIPE_SECRET_KEY"]);
  });

  it("never writes the value, and writes nothing for an empty key list", async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), "kit-secret-write-"));
    t.after(() => rmTemp(cwd));
    await recordSecretWrite(
      SECRET_WRITE_OPS.sync,
      { keys: [], target: "github", ok: true },
      { cwd },
    );
    assert.equal(existsSync(join(cwd, ".kit-audit.jsonl")), false);
    await recordSecretWrite(
      SECRET_WRITE_OPS.propagate,
      { keys: ["API_KEY"], target: "fly", ok: true },
      { cwd },
    );
    const log = readFileSync(join(cwd, ".kit-audit.jsonl"), "utf8");
    assert.match(log, /"name":"API_KEY"/);
    assert.doesNotMatch(log, /REDACTED/);
    assert.match(log, /"target":"fly"/);
    assert.doesNotMatch(log, /"value"/);
  });
});

describe("propagate records each target it tried", () => {
  it("writes a secrets.propagate event with the key name, the target and the outcome", async (t) => {
    // Like secrets-propagate.test.ts, this relies on the aws CLI not being on the runner's PATH, so
    // the adapter runs and fails without a real write. The outcome is recorded either way.
    const cwd = mkdtempSync(join(tmpdir(), "kit-secret-write-"));
    t.after(() => rmTemp(cwd));
    const [result] = await propagate("DB_URL", "not-a-real-value", ["aws-ssm"], {
      awsRegion: "eu-north-1",
      cwd,
    });
    const events = await readSecretAuditEvents(cwd, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, "secrets.propagate");
    assert.equal(events[0].success, result.ok);
    assert.deepEqual(events[0].metadata, { name: "DB_URL", target: "aws-ssm" });
    assert.doesNotMatch(readFileSync(join(cwd, ".kit-audit.jsonl"), "utf8"), /not-a-real-value/);
  });
});

describe("failedKeyNames", () => {
  it("takes the key name from `NAME: reason` lines and drops anything else", () => {
    assert.deepEqual(
      failedKeyNames(["DB_URL: 403", "API_KEY: network down", "Unknown target: x y", "bad line"]),
      ["DB_URL", "API_KEY"],
    );
  });
});
