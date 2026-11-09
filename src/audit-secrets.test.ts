import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSecretAuditEvents, groupBySecret, summarize, exposureAt } from "./audit-secrets.js";
import type { AuditEvent } from "./audit.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

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
      rmTemp(dir);
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
      rmTemp(dir);
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
      rmTemp(dir);
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
      rmTemp(dir);
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

const ev = (
  operation: string,
  timestamp: string,
  success: boolean,
  metadata: Record<string, unknown>,
): AuditEvent => ({ operation, timestamp, success, environment: "test", metadata });

describe("exposureAt", () => {
  const events = [
    ev("secrets.propagate", "2026-11-01T10:00:00Z", true, { name: "DB_URL", target: "railway" }),
    ev("secrets.rotate", "2026-11-05T10:00:00Z", true, { name: "DB_URL", target: "railway" }),
    ev("secrets.sync", "2026-11-02T10:00:00Z", true, { names: ["A", "B"], target: "railway" }),
    ev("secrets.propagate", "2026-11-03T10:00:00Z", false, { name: "C", target: "railway" }),
    ev("secrets.propagate", "2026-11-04T10:00:00Z", false, { name: "A", target: "railway" }),
    ev("secrets.propagate", "2026-11-04T10:00:00Z", true, { name: "FLY_ONLY", target: "fly" }),
  ];

  it("lists each key pushed to the target once, with its last write and every operation", () => {
    const x = exposureAt(events, "railway");
    assert.deepEqual(x.pushed, [
      { key: "A", lastPushed: "2026-11-02T10:00:00Z", operations: ["secrets.sync"] },
      { key: "B", lastPushed: "2026-11-02T10:00:00Z", operations: ["secrets.sync"] },
      {
        key: "DB_URL",
        lastPushed: "2026-11-05T10:00:00Z",
        operations: ["secrets.propagate", "secrets.rotate"],
      },
    ]);
  });

  it("keeps a key whose every write failed apart, and never lists another target's keys", () => {
    const x = exposureAt(events, "railway");
    assert.deepEqual(x.attempted, [{ key: "C", lastAttempt: "2026-11-03T10:00:00Z" }]);
    assert.ok(![...x.pushed, ...x.attempted].some((k) => k.key === "FLY_ONLY"));
  });

  it("names declared keys with no recorded write, and only those", () => {
    const x = exposureAt(events, "railway", ["DB_URL", "C", "STRIPE_SECRET", "STRIPE_SECRET"]);
    assert.deepEqual(x.declaredOnly, ["STRIPE_SECRET"]);
  });

  it("is empty for a target nothing was written to", () => {
    assert.deepEqual(exposureAt(events, "vercel"), {
      target: "vercel",
      pushed: [],
      attempted: [],
      declaredOnly: [],
    });
  });
});

describe("kit audit secrets --target (compiled CLI)", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
  it("prints the target's exposure as JSON from the project audit log and kit.toml", async (t) => {
    const dir = makeRepo([
      ev("secrets.propagate", new Date().toISOString(), true, {
        name: "DB_URL",
        target: "railway",
      }),
    ]);
    t.after(() => rmTemp(dir));
    writeFileSync(
      join(dir, ".kit.toml"),
      '[project]\nname = "x"\n\n[deploy.railway.environments.production]\nrequired = ["DB_URL", "SESSION_SECRET"]\n',
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [CLI, "audit", "secrets", "--target", "railway", "--json"],
      { cwd: dir, env: { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1" }, timeout: 60_000 },
    );
    const x = JSON.parse(stdout) as ReturnType<typeof exposureAt>;
    assert.deepEqual(
      x.pushed.map((p) => p.key),
      ["DB_URL"],
    );
    assert.deepEqual(x.declaredOnly, ["SESSION_SECRET"]);
  });
});
