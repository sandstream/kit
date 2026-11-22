import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { anchorRecordPath } from "../audit-anchor.js";
import { auditFixture } from "../audit-concurrency.test-support.js";
import { chainedAuditLog, observeEvent, writeSealedAuditLog } from "../audit-chain.test-support.js";
import { assessObserveEvidence } from "./observe-evidence.js";

describe("assessObserveEvidence: readiness rests on a log that verifies", () => {
  it("an intact chain with clean observe events is ready", () => {
    const r = assessObserveEvidence(chainedAuditLog([observeEvent([]), observeEvent([])]));
    assert.equal(r.verdict, "ready");
    assert.equal(r.opsObserved, 2);
    assert.equal(r.evidenceBreak, undefined);
  });

  it("an intact chain with a would-be denial is would-block", () => {
    const r = assessObserveEvidence(chainedAuditLog([observeEvent(["egress evil.test"])]));
    assert.equal(r.verdict, "would-block");
  });

  it("an empty log is untested, not unverifiable", () => {
    assert.equal(assessObserveEvidence("").verdict, "untested");
    assert.equal(assessObserveEvidence("\n\n").verdict, "untested");
  });

  it("a removed would-be denial leaves a broken link, so the verdict is unverifiable", () => {
    const lines = chainedAuditLog([
      observeEvent([]),
      observeEvent(["egress evil.test not in scope"]),
      observeEvent([]),
    ]).split("\n");
    const tampered = [lines[0], lines[2], ""].join("\n");
    const r = assessObserveEvidence(tampered);
    assert.equal(r.verdict, "unverifiable");
    assert.match(r.evidenceBreak ?? "", /^entry 1: broken link/);
    assert.equal(r.opsObserved, 0);
    assert.equal(r.wouldBlockOps, 0);
  });

  it("an edited would-be denial is a hash mismatch, so the verdict is unverifiable", () => {
    const log = chainedAuditLog([observeEvent(["egress evil.test not in scope"])]);
    const r = assessObserveEvidence(log.replace('["egress evil.test not in scope"]', "[]"));
    assert.equal(r.verdict, "unverifiable");
    assert.match(r.evidenceBreak ?? "", /^entry 0: hash mismatch/);
  });

  it("an unparseable line is unverifiable, never skipped", () => {
    const r = assessObserveEvidence(chainedAuditLog([observeEvent([])]) + "{not json\n");
    assert.equal(r.verdict, "unverifiable");
    assert.match(r.evidenceBreak ?? "", /^entry 1: unparseable line/);
  });

  it("observe events without a hash chain are unverifiable", () => {
    const r = assessObserveEvidence(JSON.stringify(observeEvent([])) + "\n");
    assert.equal(r.verdict, "unverifiable");
    assert.match(r.evidenceBreak ?? "", /^entry 0: missing hash/);
  });

  it("a break outranks a would-block verdict", () => {
    const log = chainedAuditLog([observeEvent(["fs /etc not in scope"])]) + "{not json\n";
    assert.equal(assessObserveEvidence(log).verdict, "unverifiable");
  });
});

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
const runBroker = (fixture: ReturnType<typeof auditFixture>, ...args: string[]) =>
  spawnSync(process.execPath, [cli, "broker", ...args], {
    cwd: fixture.project,
    env: fixture.env,
    encoding: "utf8",
    timeout: 30_000,
  });
const runReadiness = (fixture: ReturnType<typeof auditFixture>) =>
  runBroker(fixture, "enforce-readiness", "--gate", "--json");

describe("kit broker enforce-readiness verifies both evidence layers", () => {
  it("refuses an intact prefix that is shorter than the local seal", async (t) => {
    const fixture = auditFixture(t, true);
    const logPath = join(fixture.project, ".kit-audit.jsonl");
    const full = chainedAuditLog([observeEvent([]), observeEvent([])]);
    const indexPath = anchorRecordPath(join(fixture.home, "anchors"));
    await writeSealedAuditLog(logPath, full, join(fixture.home, "anchors"));
    const index = readFileSync(indexPath);
    const intact = runReadiness(fixture);
    assert.equal(intact.status, 0, intact.stdout + intact.stderr);
    assert.equal(JSON.parse(intact.stdout).verdict, "ready");

    const partial = chainedAuditLog([observeEvent([])]);
    writeFileSync(logPath, partial);
    const result = runReadiness(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "unverifiable");
    assert.match(report.evidenceBreak, /truncated/);
    assert.equal(readFileSync(logPath, "utf8"), partial);
    assert.deepEqual(readFileSync(indexPath), index);

    const profile = join(fixture.project, ".kit-profile.toml");
    const original = 'version = 1\n[scope]\negress = ["example.test"]\n';
    writeFileSync(profile, original);
    const transition = runBroker(fixture, "enforce", "--json");
    assert.equal(transition.status, 1, transition.stdout + transition.stderr);
    assert.equal(JSON.parse(transition.stdout).enforced, false);
    assert.equal(readFileSync(profile, "utf8"), original);
  });

  it("exits 1 when the audit chain is broken", (t) => {
    const fixture = auditFixture(t);
    const logPath = join(fixture.project, ".kit-audit.jsonl");
    const lines = chainedAuditLog([
      observeEvent([]),
      observeEvent(["egress evil.test not in scope"]),
      observeEvent([]),
    ]).split("\n");

    const tampered = [lines[0], lines[2], ""].join("\n");
    writeFileSync(logPath, tampered);
    const broken = runReadiness(fixture);
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    const report = JSON.parse(broken.stdout);
    assert.equal(report.verdict, "unverifiable");
    assert.match(report.evidenceBreak, /^entry 1: broken link/);
    assert.equal(readFileSync(logPath, "utf8"), tampered, "the broken log is kept byte for byte");
  });
});

for (const { content, reason, detail } of [
  { content: undefined, reason: "missing-log", detail: /log is missing/i },
  { content: "", reason: "empty-log", detail: /log is empty/i },
  { content: " \n\t\r\n", reason: "empty-log", detail: /log is empty/i },
  {
    content: chainedAuditLog([{ ...observeEvent([]), metadata: {} }]),
    reason: "no-observations",
    detail: /log has no observe events/i,
  },
]) {
  it(`enforce-readiness reports untested (${reason}, ${content?.length ?? 0} bytes)`, (t) => {
    const fixture = auditFixture(t);
    if (content !== undefined) writeFileSync(join(fixture.project, ".kit-audit.jsonl"), content);

    const json = runReadiness(fixture);
    assert.equal(json.status, 1, json.stdout + json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.verdict, "untested");
    assert.equal(report.untestedReason, reason);
    assert.equal(report.opsObserved, 0);

    const text = runBroker(fixture, "enforce-readiness", "--gate");
    assert.equal(text.status, 1, text.stdout + text.stderr);
    assert.match(text.stdout, detail);
  });
}

describe("kit broker enforce-readiness refuses incomplete evidence", () => {
  it("refuses an unsealed log, an unsealed tail and a missing anchored log", async (t) => {
    const fixture = auditFixture(t, true);
    const logPath = join(fixture.project, ".kit-audit.jsonl");
    const event = observeEvent([]);
    const sealed = chainedAuditLog([event]);
    const check = (message: RegExp) => {
      const result = runReadiness(fixture);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.verdict, "unverifiable");
      assert.match(report.evidenceBreak, message);
    };

    writeFileSync(logPath, sealed);
    check(/not anchored/i);
    await writeSealedAuditLog(logPath, sealed, join(fixture.home, "anchors"));
    writeFileSync(logPath, "");
    check(/truncated/i);
    writeFileSync(logPath, chainedAuditLog([event, event]));
    check(/unsealed/i);
    unlinkSync(logPath);
    check(/anchored broker audit log is missing/);
  });

  it("distinguishes an unreadable path from a missing log", (t) => {
    const fixture = auditFixture(t);
    mkdirSync(join(fixture.project, ".kit-audit.jsonl"));
    const result = runReadiness(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "unverifiable");
    assert.match(report.evidenceBreak, /cannot read the broker audit log/);
  });
});
