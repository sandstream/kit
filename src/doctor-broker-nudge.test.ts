import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "./doctor.js";
import { loadOrCreateIdentity } from "./identity.js";
import { PROFILE_FILE } from "./profile/schema.js";
import { signProfile } from "./profile/sign.js";
import { rmTemp } from "./temp-cleanup.test-support.js";
import { chainedAuditLog, observeEvent } from "./audit-chain.test-support.js";

describe("runDoctor — exec-broker runtime observe→enforce nudge (E3)", () => {
  let idDir: string;
  let proj: string;
  let savedId: string | undefined;

  beforeEach(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
    proj = mkdtempSync(join(tmpdir(), "kit-nudge-"));
    savedId = process.env.KIT_IDENTITY_DIR;
    process.env.KIT_IDENTITY_DIR = idDir;
    loadOrCreateIdentity();
  });

  afterEach(() => {
    if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = savedId;
    rmTemp(idDir);
    rmTemp(proj);
  });

  const observe = observeEvent;
  const rtRow = async () =>
    (await runDoctor({}, proj)).checks.find((c) => c.name === "exec-broker runtime");

  async function signedObserveProfile(): Promise<void> {
    writeFileSync(
      join(proj, PROFILE_FILE),
      `version = 1\n[scope]\negress = ["api.acme.com"]\nenforce_runtime = "observe"\n`,
      "utf-8",
    );
    await signProfile(proj);
  }

  it("a clean observe window nudges to 'kit broker enforce'", async () => {
    await signedObserveProfile();
    writeFileSync(
      join(proj, ".kit-audit.jsonl"),
      chainedAuditLog([observe([]), observe([])]),
      "utf-8",
    );
    const row = await rtRow();
    assert.ok(row);
    assert.equal(row.status, "warn");
    assert.match(row.detail, /kit broker enforce/);
    assert.match(row.detail, /none would be denied/);
  });

  it("a would-block observe window points to enforce-readiness, not the flip", async () => {
    await signedObserveProfile();
    writeFileSync(
      join(proj, ".kit-audit.jsonl"),
      chainedAuditLog([observe(["egress evil.test not in scope"])]),
      "utf-8",
    );
    const row = await rtRow();
    assert.ok(row);
    assert.equal(row.status, "warn");
    assert.match(row.detail, /enforce-readiness/);
    assert.doesNotMatch(row.detail, /Safe to graduate/);
  });

  it("a log with a broken chain never nudges to the flip", async () => {
    await signedObserveProfile();
    const lines = chainedAuditLog([observe([]), observe(["egress evil.test"]), observe([])]).split(
      "\n",
    );
    writeFileSync(join(proj, ".kit-audit.jsonl"), [lines[0], lines[2], ""].join("\n"), "utf-8");
    const row = await rtRow();
    assert.ok(row);
    assert.equal(row.status, "warn");
    assert.match(row.detail, /audit chain is broken/);
    assert.match(row.detail, /kit audit verify/);
    assert.doesNotMatch(row.detail, /Safe to graduate/);
  });
});
