import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdBroker } from "./broker.js";
import { loadOrCreateIdentity } from "../identity.js";
import { loadProfile, PROFILE_FILE } from "../profile/schema.js";
import { rmTemp } from "../temp-cleanup.test-support.js";
import { chainedAuditLog, observeEvent } from "../audit-chain.test-support.js";

// A log whose hash chain is broken is not evidence. No broker command gives a verdict from
// the events that are left in it.

let dir: string;
let idDir: string;
let cwd: string;
let argv: string[];
let savedId: string | undefined;
let logs: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-broker-unverifiable-"));
  idDir = mkdtempSync(join(tmpdir(), "kit-broker-unverifiable-id-"));
  savedId = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
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
  if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedId;
  rmTemp(dir);
  rmTemp(idDir);
});

function setArgs(...sub: string[]): void {
  process.argv = ["node", "kit", "broker", ...sub];
}

function writeLog(content: string): void {
  writeFileSync(join(dir, ".kit-audit.jsonl"), content, "utf-8");
}

/** Two clean-looking events are left after the would-be denial in the middle is removed. */
function logWithRemovedDenial(): string {
  const lines = chainedAuditLog([
    observeEvent([]),
    observeEvent(["egress evil.test"]),
    observeEvent([]),
  ]).split("\n");
  return [lines[0], lines[2], ""].join("\n");
}

describe("cmdBroker enforce-readiness on a log that does not verify", () => {
  it("a malformed log is unverifiable: no throw, and no verdict from what is left", async () => {
    writeLog("{not json\n\n" + chainedAuditLog([observeEvent([])]) + "null\n");
    setArgs("enforce-readiness", "--json");
    assert.equal(await cmdBroker(), true);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.verdict, "unverifiable");
    assert.match(out.evidenceBreak, /^entry 0: unparseable line/);
  });

  it("--gate fails, also when every remaining event is clean", async () => {
    writeLog(logWithRemovedDenial());
    setArgs("enforce-readiness", "--gate");
    assert.equal(await cmdBroker(), false);
    const text = logs.join("\n");
    assert.match(text, /unverifiable/);
    assert.match(text, /entry 1: broken link/);
    assert.match(text, /kit audit verify/);
    assert.doesNotMatch(text, /✓ ready/);
  });
});

describe("cmdBroker enforce on a log that does not verify", () => {
  beforeEach(() => {
    loadOrCreateIdentity();
    writeFileSync(
      join(dir, PROFILE_FILE),
      `version = 1\n[scope]\negress = ["api.acme.com"]\nfs = ["src"]\n`,
    );
  });

  it("refuses without --force; profile unchanged", async () => {
    writeLog(logWithRemovedDenial());
    setArgs("enforce", "--json");
    assert.equal(await cmdBroker(), false);
    const out = JSON.parse(logs.join("\n"));
    assert.equal(out.enforced, false);
    assert.equal(out.verdict, "unverifiable");
    assert.match(out.reason, /Cannot verify.*entry 1: broken link/);
    assert.notEqual((await loadProfile(dir))?.scope?.enforce_runtime, true);
  });

  it("--force can override unverifiable observations when the configured audit log accepts writes", async () => {
    writeLog(logWithRemovedDenial());
    writeFileSync(
      join(dir, ".kit.toml"),
      '[governance.audit]\nenabled = true\nlog_file = "transition-audit.jsonl"\n',
    );
    setArgs("enforce", "--force");
    assert.equal(await cmdBroker(), true);
    assert.equal((await loadProfile(dir))?.scope?.enforce_runtime, true);
  });
});
