import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appendAuditEventDirect, type AuditEvent } from "../audit.js";
import { COVERAGE, type KeyAccessAnswer } from "../audit-secrets-query.js";
import { governanceFixture } from "../governance-outcome.test-support.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
const SINCE = "2026-11-01T00:00:00Z";

// Names and metadata only: audit events never carry a value.
const EVENTS: AuditEvent[] = [
  ev("secrets.read", "2026-10-30T09:00:00Z", { name: "DEMO_PIN", store: "aws-sm", via: "kit run" }),
  ev("secrets.read", "2026-11-02T09:00:00Z", { name: "DEMO_PIN", store: "aws-sm", via: "kit run" }),
  ev("secrets.rotate", "2026-11-03T09:00:00Z", { name: "DEMO_PIN", target: "aws-sm" }),
  ev("secrets.generate", "2026-11-05T09:00:00Z", { store: "env" }),
];

function ev(operation: string, timestamp: string, metadata: Record<string, unknown>): AuditEvent {
  return { timestamp, operation, environment: "dev", success: true, metadata };
}

async function chainedProject(t: TestContext): Promise<string> {
  const { target } = governanceFixture(t);
  for (const e of EVENTS) await appendAuditEventDirect(e, { cwd: target });
  return target;
}

async function query(cwd: string, ...extra: string[]) {
  const since = extra[0] === "--since" ? extra.splice(0, 2)[1]! : SINCE;
  const args = [CLI, "audit", "secrets", "--key", "DEMO_PIN", "--since", since, ...extra];
  const env = { ...process.env, KIT_HIDE_HOOK_SKIP_BANNER: "1" };
  return promisify(execFile)(process.execPath, args, { cwd, env, timeout: 60_000 }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );
}

describe("kit audit secrets --key --since (compiled CLI)", () => {
  it("answers from a verified chain, as JSON, exit 0", async (t) => {
    const r = await query(await chainedProject(t), "--json");
    assert.equal(r.code, 0, r.stderr);
    const a = JSON.parse(r.stdout) as KeyAccessAnswer;
    assert.deepEqual([a.chain.verified, a.chain.status, a.chain.entries], [true, "intact", 4]);
    assert.deepEqual([a.reads, a.writes, a.unattributed], [1, 1, 1]);
    assert.equal(a.coverage, COVERAGE);
  });

  it("says plainly what it covers and that the chain verified", async (t) => {
    const r = await query(await chainedProject(t));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Coverage: reads through kit only; processes that read \.env\.local/);
    assert.match(r.stdout, /audit chain verified/);
    assert.match(r.stdout, /1 read\(s\) and 1 write\(s\) of DEMO_PIN/);
  });

  it("exits non-zero and says so when the chain does not verify", async (t) => {
    const dir = await chainedProject(t);
    const log = join(dir, ".kit-audit.jsonl");
    writeFileSync(log, readFileSync(log, "utf-8").replace('"kit run"', '"kit fix"'));
    const r = await query(dir, "--json");
    assert.equal(r.code, 1);
    const a = JSON.parse(r.stdout) as KeyAccessAnswer;
    assert.deepEqual([a.chain.verified, a.chain.status], [false, "broken"]);
    const text = await query(dir);
    assert.equal(text.code, 1);
    assert.match(text.stderr, /audit chain did not verify/);
  });

  it("refuses a --since that is not an ISO 8601 date", async (t) => {
    const r = await query(await chainedProject(t), "--since", "last tuesday");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Usage: kit audit secrets --key <NAME> --since/);
  });
});
