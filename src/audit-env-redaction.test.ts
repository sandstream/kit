import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEventDirect, verifyAuditChain } from "./audit.js";
import { assessEnforceReadiness, parseObserveRecords } from "./exec-broker/enforce-readiness.js";

describe("audit env-aware redaction", () => {
  it("removes opaque env secrets before metadata is hashed or persisted", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-audit-env-secret-"));
    const previous = process.env.TEST_API_TOKEN;
    const secret = "opaque-audit-value-" + "V".repeat(32);
    process.env.TEST_API_TOKEN = secret;
    try {
      const ok = await appendAuditEventDirect(
        {
          operation: `run ${secret}`,
          environment: "dev",
          success: false,
          error: `provider rejected ${secret}`,
          metadata: { detail: secret, nested: ["request_id=req_audit", secret] },
        },
        { cwd: root },
      );

      assert.equal(ok, true);
      const raw = readFileSync(join(root, ".kit-audit.jsonl"), "utf8");
      assert.ok(!raw.includes(secret));
      assert.match(raw, /\[REDACTED\]/);
      assert.match(raw, /request_id=req_audit/);
      assert.deepEqual(JSON.parse(raw).metadata.nested, ["request_id=req_audit", "[REDACTED]"]);
      assert.equal(verifyAuditChain(raw).ok, true);
    } finally {
      if (previous === undefined) delete process.env.TEST_API_TOKEN;
      else process.env.TEST_API_TOKEN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("audit redaction preserves structured evidence", () => {
  it("preserves nested arrays and observe denials through redaction and audit persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-audit-array-"));
    try {
      for (const wouldDeny of [[], ["egress outside declared scope"]]) {
        assert.equal(
          await appendAuditEventDirect(
            {
              operation: "bash",
              environment: "test",
              success: true,
              metadata: {
                phase: "observe",
                wouldDeny,
                nested: [[{ password: "private-passphrase", label: "safe" }], null, 3, false],
              },
            },
            { cwd: root },
          ),
          true,
        );
      }
      const raw = readFileSync(join(root, ".kit-audit.jsonl"), "utf8");
      const events = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(
        events.map((event) => event.metadata.wouldDeny),
        [[], ["egress outside declared scope"]],
      );
      assert.deepEqual(events[0].metadata.nested, [
        [{ password: "[REDACTED]", label: "safe" }],
        null,
        3,
        false,
      ]);
      assert.ok(!raw.includes("private-passphrase"));
      assert.equal(verifyAuditChain(raw).ok, true);
      assert.equal(assessEnforceReadiness(parseObserveRecords(raw)).verdict, "would-block");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("audit metadata-key redaction", () => {
  it("redacts by metadata KEY NAME too, not just by pattern/env-value (RED-3)", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-audit-metadata-key-"));
    try {
      // "hunter2" matches no known credential shape and isn't a process-env value:
      // only a key-name check (metadata.password) can catch it.
      const ok = await appendAuditEventDirect(
        {
          operation: "login attempt",
          environment: "dev",
          success: false,
          metadata: { username: "alice", password: "hunter2" },
        },
        { cwd: root },
      );

      assert.equal(ok, true);
      const raw = readFileSync(join(root, ".kit-audit.jsonl"), "utf8");
      assert.ok(!raw.includes("hunter2"));
      assert.match(raw, /\[REDACTED\]/);
      assert.match(raw, /alice/);
      assert.equal(verifyAuditChain(raw).ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
