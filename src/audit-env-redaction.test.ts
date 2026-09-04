import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEventDirect, verifyAuditChain } from "./audit.js";

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
      assert.equal(verifyAuditChain(raw).ok, true);
    } finally {
      if (previous === undefined) delete process.env.TEST_API_TOKEN;
      else process.env.TEST_API_TOKEN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
