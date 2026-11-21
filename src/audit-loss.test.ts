import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// An audit event that cannot be written used to leave one line on stderr and exit code 0.
// Seven callers ignored the boolean that reports it, two of them with `void`. A lost event was
// then invisible to every script and hook that reads only the exit code.
const AUDIT = pathToFileURL(join(process.cwd(), "src", "audit.ts")).href;
const TSX = import.meta.resolve("tsx");

/** Run a script in a child process. `log` is a log path that can, or cannot, be written. */
function runChild(body: string, writable: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "kit-audit-loss-"));
  // A regular file where the log's directory should be: the append fails on every platform.
  writeFileSync(join(dir, "blocker"), "not a directory");
  const logFile = writable ? "audit.jsonl" : join("blocker", "audit.jsonl");
  const script = `
    const { appendAuditEventDirect, logAuditEvent } = await import(${JSON.stringify(AUDIT)});
    const event = { operation: "fixture.loss", environment: "local", success: true };
    const governance = {
      enabled: true,
      environment: "dev",
      access: {},
      agent: { id: "a", name: "A" },
      audit: { enabled: true, log_file: ${JSON.stringify(logFile)}, include_secrets: false },
      approval: {},
      secrets: {},
      revocation: {},
      scan: {},
      containment: {},
    };
    const opts = { cwd: ${JSON.stringify(dir)}, logFile: ${JSON.stringify(logFile)} };
    ${body}
  `;
  try {
    return spawnSync(process.execPath, ["--import", TSX, "--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, KIT_AUDIT_LOCK_WAIT_MS: "" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("a lost audit event is never silent", () => {
  it("exits non-zero when the caller ignores the result", () => {
    const result = runChild("await appendAuditEventDirect(event, opts);", false);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /1 audit event was not recorded/);
  });

  it("exits non-zero when the caller does not wait for the append", () => {
    const result = runChild("void appendAuditEventDirect(event, opts);", false);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
  });

  it("exits non-zero when the command asks for exit code 0", () => {
    const result = runChild("await appendAuditEventDirect(event, opts); process.exit(0);", false);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
  });

  it("counts every lost event", () => {
    const body =
      "await appendAuditEventDirect(event, opts); await appendAuditEventDirect(event, opts);";
    const result = runChild(body, false);
    assert.ifError(result.error);
    assert.match(result.stderr, /2 audit events were not recorded/);
  });

  it("keeps a gate's own refusal code", () => {
    // Exit code 2 is how a gate hook refuses a tool call. A lost event must not turn a refusal
    // into the weaker code 1.
    const body = "await appendAuditEventDirect(event, opts); process.exitCode = 2;";
    const result = runChild(body, false);
    assert.ifError(result.error);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /1 audit event was not recorded/);
  });

  it("still tells the caller with the boolean", () => {
    const body =
      "const ok = await appendAuditEventDirect(event, opts); process.stdout.write('OK=' + ok);";
    const result = runChild(body, false);
    assert.ifError(result.error);
    assert.match(result.stdout, /OK=false/);
  });

  it("covers the governed append too", () => {
    const body =
      "const ok = await logAuditEvent(governance, event, { cwd: opts.cwd }); process.stdout.write('OK=' + ok);";
    const result = runChild(body, false);
    assert.ifError(result.error);
    assert.match(result.stdout, /OK=false/);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /1 audit event was not recorded/);
  });

  it("leaves the exit code alone when the event is recorded", () => {
    const body =
      "const ok = await appendAuditEventDirect(event, opts); process.stdout.write('OK=' + ok);";
    const result = runChild(body, true);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OK=true/);
    assert.doesNotMatch(result.stderr, /not recorded/);
  });
});
