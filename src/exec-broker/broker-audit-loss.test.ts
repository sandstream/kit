import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrokerContext } from "./broker.js";
import type { BrokerPolicy } from "./policy.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const BROKER = pathToFileURL(join(process.cwd(), "src", "exec-broker", "broker.ts")).href;
const TSX = import.meta.resolve("tsx");

const POLICY: BrokerPolicy = {
  egress: { allow: ["api.example.com"] },
  fs: { root: "/repo" },
  env: { declared: ["TOKEN", "REGION"] },
};

const CONTEXT: BrokerContext = {
  operation: "test.op",
  operationType: "write",
  declaredEffects: true,
};

describe("brokerExec fail-closed audit", () => {
  it("refuses to run when the pre-exec 'authorized' audit append fails", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kit-broker-"));
    // Isolate identity so audit signing never touches a real ~/.kit.
    const identityDir = mkdtempSync(join(tmpdir(), "kit-broker-id-"));
    try {
      // Force appendAuditEventDirect to return false by making the audit path a
      // DIRECTORY, so appendFile fails with EISDIR even as root (permission-
      // independent).
      mkdirSync(join(sandbox, ".kit-audit.jsonl"));
      // It runs in a child process: a failed append also fails the process that made it
      // (src/audit-loss.ts), and that process must not be this test file.
      const script = `
        const { brokerExec } = await import(${JSON.stringify(BROKER)});
        let ran = false;
        const out = await brokerExec(
          ${JSON.stringify(CONTEXT)},
          ${JSON.stringify(POLICY)},
          async () => { ran = true; return 1; },
        );
        process.stdout.write(JSON.stringify({ ok: out.ok, reason: out.reason, ran }));
      `;
      const child = spawnSync(
        process.execPath,
        ["--import", TSX, "--input-type=module", "-e", script],
        {
          cwd: sandbox,
          encoding: "utf8",
          timeout: 120_000,
          env: { ...process.env, KIT_IDENTITY_DIR: identityDir },
        },
      );
      assert.ifError(child.error);
      const out = JSON.parse(child.stdout) as { ok: boolean; reason?: string; ran: boolean };
      assert.equal(out.ok, false);
      assert.match(out.reason ?? "", /audit-log unavailable.*fail-closed/);
      assert.equal(out.ran, false);
      assert.equal(child.status, 1, child.stderr);
      assert.match(child.stderr, /1 audit event was not recorded/);
    } finally {
      rmTemp(sandbox);
      rmTemp(identityDir);
    }
  });
});
