import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdBroker, enforceGateDecision } from "./broker.js";
import { loadOrCreateIdentity } from "../identity.js";
import { loadProfile, PROFILE_FILE } from "../profile/schema.js";

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

describe("enforceGateDecision (pure pre-flight)", () => {
  const R = (
    verdict: "ready" | "would-block" | "untested",
    wouldBlockOps = 0,
    opsObserved = 0,
  ) => ({
    verdict,
    opsObserved,
    wouldBlockOps,
    reasons: [],
  });

  it("ready → proceed (unforced)", () => {
    assert.equal(enforceGateDecision(R("ready", 0, 3), false).proceed, true);
  });
  it("would-block → refuse unforced, proceed with --force", () => {
    assert.equal(enforceGateDecision(R("would-block", 2, 5), false).proceed, false);
    assert.equal(enforceGateDecision(R("would-block", 2, 5), true).proceed, true);
  });
  it("untested → refuse unforced, proceed with --force", () => {
    assert.equal(enforceGateDecision(R("untested"), false).proceed, false);
    assert.equal(enforceGateDecision(R("untested"), true).proceed, true);
  });
});

describe("cmdBroker enforce (guided, signed flip)", () => {
  let idDir: string;
  let projDir: string;
  let cwd0: string;
  let argv0: string[];
  let savedId: string | undefined;
  let logs: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  const SCOPED = `version = 1\n[scope]\negress = ["api.acme.com"]\nfs = ["src"]\n`;
  const observe = (wouldDeny: string[]) =>
    JSON.stringify({ operation: "bash", success: true, metadata: { phase: "observe", wouldDeny } });

  beforeEach(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-broker-id-"));
    projDir = mkdtempSync(join(tmpdir(), "kit-broker-enf-"));
    savedId = process.env.KIT_IDENTITY_DIR;
    process.env.KIT_IDENTITY_DIR = idDir;
    loadOrCreateIdentity();
    writeFileSync(join(projDir, PROFILE_FILE), SCOPED);
    cwd0 = process.cwd();
    process.chdir(projDir);
    argv0 = process.argv;
    logs = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  });

  afterEach(() => {
    process.chdir(cwd0);
    process.argv = argv0;
    console.log = origLog;
    console.error = origErr;
    if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = savedId;
    rmSync(idDir, { recursive: true, force: true });
    rmSync(projDir, { recursive: true, force: true });
  });

  const setArgs = (...sub: string[]): void => {
    process.argv = ["node", "kit", "broker", ...sub];
  };
  const writeAudit = (...lines: string[]): void =>
    writeFileSync(join(projDir, ".kit-audit.jsonl"), lines.join("\n") + "\n", "utf-8");

  it("refuses when untested (no observe data) without --force; profile unchanged", async () => {
    setArgs("enforce", "--json");
    assert.equal(await cmdBroker(), false);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.enforced, false);
    assert.equal(out.verdict, "untested");
    assert.notEqual((await loadProfile(projDir))?.scope?.enforce_runtime, true);
  });

  it("refuses would-block without --force; profile unchanged", async () => {
    writeAudit(observe(["egress evil.test not in scope"]));
    setArgs("enforce");
    assert.equal(await cmdBroker(), false);
    assert.notEqual((await loadProfile(projDir))?.scope?.enforce_runtime, true);
  });

  it("flips + re-signs when ready", async () => {
    writeAudit(observe([]), observe([]));
    setArgs("enforce", "--json");
    assert.equal(await cmdBroker(), true);
    assert.equal((await loadProfile(projDir))?.scope?.enforce_runtime, true);
    assert.ok(existsSync(join(projDir, ".kit-profile.sig")), "profile scope re-signed");
  });

  it("--force flips despite would-block", async () => {
    writeAudit(observe(["egress evil.test not in scope"]));
    setArgs("enforce", "--force");
    assert.equal(await cmdBroker(), true);
    assert.equal((await loadProfile(projDir))?.scope?.enforce_runtime, true);
  });

  it("refuses when no [scope] is declared", async () => {
    writeFileSync(join(projDir, PROFILE_FILE), `version = 1\n`);
    setArgs("enforce");
    assert.equal(await cmdBroker(), false);
    assert.match(logs.join("\n"), /no \[scope\]/);
  });
});
