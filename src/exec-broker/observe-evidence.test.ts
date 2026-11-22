import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { auditFixture } from "../audit-concurrency.test-support.js";
import { chainedAuditLog, observeEvent } from "../audit-chain.test-support.js";
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
    // The counts of what remains are still reported, but never as a verdict.
    assert.equal(r.opsObserved, 2);
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

describe("kit broker enforce-readiness --gate, through the real CLI", () => {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const run = (fixture: ReturnType<typeof auditFixture>, ...args: string[]) =>
    spawnSync(process.execPath, [cli, "broker", "enforce-readiness", ...args], {
      cwd: fixture.project,
      env: fixture.env,
      encoding: "utf8",
      timeout: 30_000,
    });

  it("exits 0 on an intact clean log and 1 once a would-be denial is removed", (t) => {
    if (!existsSync(cli)) return t.skip("needs the compiled CLI (npm run build)");
    const fixture = auditFixture(t);
    const logPath = join(fixture.project, ".kit-audit.jsonl");
    const lines = chainedAuditLog([
      observeEvent([]),
      observeEvent(["egress evil.test not in scope"]),
      observeEvent([]),
    ]).split("\n");

    writeFileSync(logPath, [lines[0], ""].join("\n"));
    const intact = run(fixture, "--gate", "--json");
    assert.equal(intact.status, 0, intact.stderr);
    assert.equal(JSON.parse(intact.stdout).verdict, "ready");

    const tampered = [lines[0], lines[2], ""].join("\n");
    writeFileSync(logPath, tampered);
    const broken = run(fixture, "--gate", "--json");
    assert.equal(broken.status, 1, broken.stdout + broken.stderr);
    const report = JSON.parse(broken.stdout);
    assert.equal(report.verdict, "unverifiable");
    assert.match(report.evidenceBreak, /^entry 1: broken link/);
    assert.equal(readFileSync(logPath, "utf8"), tampered, "the broken log is kept byte for byte");
  });
});
