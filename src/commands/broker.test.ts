import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdBroker } from "./broker.js";

let dir: string;
let cwd: string;
let argv: string[];
let logs: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-broker-cmd-"));
  cwd = process.cwd();
  process.chdir(dir);
  argv = process.argv;
  logs = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
});

afterEach(() => {
  process.chdir(cwd);
  process.argv = argv;
  console.log = origLog;
  console.error = origErr;
  rmSync(dir, { recursive: true, force: true });
});

function setArgs(...sub: string[]): void {
  process.argv = ["node", "kit", "broker", ...sub];
}

function writeAudit(...lines: string[]): void {
  writeFileSync(join(dir, ".kit-audit.jsonl"), lines.join("\n") + "\n", "utf-8");
}

const observe = (wouldDeny: string[]): string =>
  JSON.stringify({ operation: "bash", success: true, metadata: { phase: "observe", wouldDeny } });

describe("cmdBroker enforce-readiness", () => {
  it("no audit file → untested, exit 0 (honest floor, never a green ready)", async () => {
    setArgs("enforce-readiness", "--json");
    const ok = await cmdBroker();
    assert.equal(ok, true);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.verdict, "untested");
    assert.equal(out.opsObserved, 0);
    assert.equal(out.coverage, "observed-ops-only");
  });

  it("all observed ops would pass → ready (JSON)", async () => {
    writeAudit(observe([]), observe([]));
    setArgs("enforce-readiness", "--json");
    const ok = await cmdBroker();
    assert.equal(ok, true);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.verdict, "ready");
    assert.equal(out.opsObserved, 2);
    assert.equal(out.wouldBlockOps, 0);
  });

  it("a would-be denial → would-block with the exact reasons tallied (JSON)", async () => {
    writeAudit(observe(["egress api.evil.test not in scope"]), observe([]));
    setArgs("enforce-readiness", "--json");
    const ok = await cmdBroker();
    assert.equal(ok, true); // informational without --gate
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.verdict, "would-block");
    assert.equal(out.wouldBlockOps, 1);
    assert.deepEqual(out.reasons, [{ reason: "egress api.evil.test not in scope", count: 1 }]);
  });

  it("--gate makes a would-block verdict fail CI (exit non-zero)", async () => {
    writeAudit(observe(["fs /etc not in scope"]));
    setArgs("enforce-readiness", "--json", "--gate");
    const ok = await cmdBroker();
    assert.equal(ok, false);
  });

  it("--gate treats untested as not-ready (fail CI — never a false green)", async () => {
    setArgs("enforce-readiness", "--gate");
    const ok = await cmdBroker();
    assert.equal(ok, false);
  });

  it("--gate passes only when ready", async () => {
    writeAudit(observe([]));
    setArgs("enforce-readiness", "--gate");
    const ok = await cmdBroker();
    assert.equal(ok, true);
  });

  it("human output lists the blocking reasons", async () => {
    writeAudit(observe(["egress evil.test"]), observe(["egress evil.test"]));
    setArgs("enforce-readiness");
    const ok = await cmdBroker();
    assert.equal(ok, true);
    const text = logs.join("\n");
    assert.match(text, /would-block/);
    assert.match(text, /2×/);
    assert.match(text, /egress evil\.test/);
  });

  it("tolerates a malformed audit log without throwing", async () => {
    writeAudit("{not json", "", observe(["r1"]), "null");
    setArgs("enforce-readiness", "--json");
    const ok = await cmdBroker();
    assert.equal(ok, true);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.verdict, "would-block");
    assert.equal(out.opsObserved, 1);
  });

  it("defaults to enforce-readiness when no subcommand is given", async () => {
    setArgs("--json");
    const ok = await cmdBroker();
    assert.equal(ok, true);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.verdict, "untested");
  });

  it("an unknown subcommand fails with usage", async () => {
    setArgs("bogus");
    const ok = await cmdBroker();
    assert.equal(ok, false);
    assert.match(logs.join("\n"), /usage: kit broker/);
  });
});
