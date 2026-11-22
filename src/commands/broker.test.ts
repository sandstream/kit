import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdBroker, enforceGateDecision } from "./broker.js";
import { loadOrCreateIdentity } from "../identity.js";
import { loadProfile, PROFILE_FILE } from "../profile/schema.js";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { chainedAuditLog, observeEvent, writeSealedAuditLog } from "../audit-chain.test-support.js";

let dir: string;
let cwd: string;
let argv: string[];
let logs: string[];
let stdout: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
let savedAnchor: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-broker-cmd-"));
  savedAnchor = process.env.KIT_AUDIT_ANCHOR_DIR;
  process.env.KIT_AUDIT_ANCHOR_DIR = join(dir, "anchors");
  cwd = process.cwd();
  process.chdir(dir);
  argv = process.argv;
  logs = [];
  stdout = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => {
    const line = a.join(" ");
    stdout.push(line);
    logs.push(line);
  };
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
});

afterEach(() => {
  process.chdir(cwd);
  process.argv = argv;
  console.log = origLog;
  console.error = origErr;
  if (savedAnchor === undefined) delete process.env.KIT_AUDIT_ANCHOR_DIR;
  else process.env.KIT_AUDIT_ANCHOR_DIR = savedAnchor;
  rmTemp(dir);
});

function setArgs(...sub: string[]): void {
  process.argv = ["node", "kit", "broker", ...sub];
}

/** Write a log with a valid hash chain, as kit's own writer produces it. */
function writeAudit(project: string, ...events: Record<string, unknown>[]): Promise<void> {
  return writeSealedAuditLog(
    join(project, ".kit-audit.jsonl"),
    chainedAuditLog(events),
    join(dir, "anchors"),
  );
}

const observe = observeEvent;

describe("cmdBroker enforce-readiness", () => {
  it("no audit file → untested, exit 0 (honest floor, never a green ready)", async () => {
    setArgs("enforce-readiness", "--json");
    const ok = await cmdBroker();
    assert.equal(ok, true);
    const out = JSON.parse(stdout.join("\n"));
    assert.equal(out.verdict, "untested");
    assert.equal(out.opsObserved, 0);
    assert.equal(out.coverage, "observed-ops-only");
  });

  it("all observed ops would pass → ready (JSON)", async () => {
    await writeAudit(dir, observe([]), observe([]));
    setArgs("enforce-readiness", "--json");
    const ok = await cmdBroker();
    assert.equal(ok, true);
    const out = JSON.parse(stdout.join("\n"));
    assert.equal(out.verdict, "ready");
    assert.equal(out.opsObserved, 2);
    assert.equal(out.wouldBlockOps, 0);
  });

  it("a would-be denial → would-block with the exact reasons tallied (JSON)", async () => {
    await writeAudit(dir, observe(["egress api.evil.test not in scope"]), observe([]));
    setArgs("enforce-readiness", "--json");
    const ok = await cmdBroker();
    assert.equal(ok, true); // informational without --gate
    const out = JSON.parse(stdout.join("\n"));
    assert.equal(out.verdict, "would-block");
    assert.equal(out.wouldBlockOps, 1);
    assert.deepEqual(out.reasons, [{ reason: "egress api.evil.test not in scope", count: 1 }]);
  });

  it("--gate makes a would-block verdict fail CI (exit non-zero)", async () => {
    await writeAudit(dir, observe(["fs /etc not in scope"]));
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
    await writeAudit(dir, observe([]));
    setArgs("enforce-readiness", "--gate");
    const ok = await cmdBroker();
    assert.equal(ok, true);
  });

  it("human output lists the blocking reasons", async () => {
    await writeAudit(dir, observe(["egress evil.test"]), observe(["egress evil.test"]));
    setArgs("enforce-readiness");
    const ok = await cmdBroker();
    assert.equal(ok, true);
    const text = logs.join("\n");
    assert.match(text, /would-block/);
    assert.match(text, /2×/);
    assert.match(text, /egress evil\.test/);
  });

  it("defaults to enforce-readiness when no subcommand is given", async () => {
    setArgs("--json");
    const ok = await cmdBroker();
    assert.equal(ok, true);
    const out = JSON.parse(stdout.join("\n"));
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
  let savedId: string | undefined;

  const SCOPED = `version = 1\n[scope]\negress = ["api.acme.com"]\nfs = ["src"]\n`;
  const observe = observeEvent;

  beforeEach(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-broker-id-"));
    projDir = mkdtempSync(join(tmpdir(), "kit-broker-enf-"));
    savedId = process.env.KIT_IDENTITY_DIR;
    process.env.KIT_IDENTITY_DIR = idDir;
    loadOrCreateIdentity();
    writeFileSync(join(projDir, PROFILE_FILE), SCOPED);
    process.chdir(projDir);
  });

  afterEach(() => {
    process.chdir(dir);
    if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = savedId;
    rmTemp(idDir);
    rmTemp(projDir);
  });

  it("refuses when untested (no observe data) without --force; profile unchanged", async () => {
    setArgs("enforce", "--json");
    assert.equal(await cmdBroker(), false);
    const out = JSON.parse(stdout.join("\n"));
    assert.equal(out.enforced, false);
    assert.equal(out.verdict, "untested");
    assert.notEqual((await loadProfile(projDir))?.scope?.enforce_runtime, true);
  });

  it("refuses would-block without --force; profile unchanged", async () => {
    await writeAudit(projDir, observe(["egress evil.test not in scope"]));
    setArgs("enforce");
    assert.equal(await cmdBroker(), false);
    assert.notEqual((await loadProfile(projDir))?.scope?.enforce_runtime, true);
  });

  it("flips + re-signs when ready", async () => {
    await writeAudit(projDir, observe([]), observe([]));
    setArgs("enforce", "--json");
    assert.equal(await cmdBroker(), true);
    assert.equal((await loadProfile(projDir))?.scope?.enforce_runtime, true);
    assert.ok(existsSync(join(projDir, ".kit-profile.sig")), "profile scope re-signed");
  });

  it("--force flips despite would-block", async () => {
    await writeAudit(projDir, observe(["egress evil.test not in scope"]));
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
