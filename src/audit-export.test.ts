import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toCef, toSyslog, exportAudit } from "./audit-export.js";
import type { AuditEvent } from "./audit.js";

const ev: AuditEvent = {
  timestamp: "2026-06-23T10:00:00.000Z",
  agent_id: "agent-1",
  agent_name: "Agent One",
  operation: "secrets.rotate",
  environment: "prod",
  success: false,
  duration_ms: 42,
  error: "denied | because reasons",
};

describe("toCef", () => {
  it("emits a well-formed CEF header + extensions", () => {
    const line = toCef(ev);
    assert.ok(line.startsWith("CEF:0|kit|kit|1|secrets.rotate|secrets.rotate|7|"));
    assert.match(line, /outcome=failure/);
    assert.match(line, /suser=Agent One/);
    assert.match(line, /cs1Label=environment cs1=prod/);
    assert.match(line, /cn1Label=durationMs cn1=42/);
    assert.match(line, /rt=\d+/);
  });

  it("escapes `=` and pipes/newlines in values", () => {
    const line = toCef(ev);
    // the error contained a pipe + would-be `=`; newlines/`=` are escaped in ext
    assert.match(line, /msg=denied \\?\| because reasons/);
    assert.ok(!line.includes("denied | because reasons\n"));
  });

  it("ranks success lower (sev 3) than failure (sev 7)", () => {
    assert.ok(toCef({ ...ev, success: true }).includes("|3|"));
    assert.ok(toCef({ ...ev, success: false }).includes("|7|"));
  });
});

describe("toSyslog", () => {
  it("wraps the CEF line in an RFC 5424 frame", () => {
    const line = toSyslog(ev, "host1");
    assert.ok(line.startsWith("<13>1 2026-06-23T10:00:00.000Z host1 kit - audit - CEF:0|kit|kit|"));
  });
});

describe("exportAudit", () => {
  it("renders one record per line for each format", () => {
    const out = exportAudit([ev, { ...ev, operation: "check", success: true }], "cef");
    const lines = out.split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes("secrets.rotate"));
    assert.ok(lines[1].includes("|3|")); // second is success
  });

  it("json format round-trips", () => {
    const out = exportAudit([ev], "json");
    assert.deepEqual(JSON.parse(out), ev);
  });
});
