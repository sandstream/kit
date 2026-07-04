/**
 * resolveKeyStore() honesty + determinism. Env vars saved/restored per repo
 * convention; a KIT_IDENTITY_DIR tmpdir backs the end-to-end sign check.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySignature } from "../identity.js";
import { FileKeyStore } from "./file-store.js";
import { resolveKeyStore } from "./resolve.js";

describe("resolveKeyStore", () => {
  let dir: string;
  const prevIdentityDir = process.env.KIT_IDENTITY_DIR;
  const prevKeystore = process.env.KIT_KEYSTORE;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-keystore-resolve-"));
    process.env.KIT_IDENTITY_DIR = dir;
  });
  after(() => {
    if (prevIdentityDir === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prevIdentityDir;
    if (prevKeystore === undefined) delete process.env.KIT_KEYSTORE;
    else process.env.KIT_KEYSTORE = prevKeystore;
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    delete process.env.KIT_KEYSTORE;
  });

  it("AUTO falls back to file, degraded with a non-empty reason quoting a skipped hardware backend", () => {
    const r = resolveKeyStore();
    assert.equal(r.store.kind, "file");
    assert.equal(r.degraded, true);
    assert.equal(typeof r.reason, "string");
    assert.ok(r.reason && r.reason.length > 0);
    // reason references a skipped hardware backend requirement.
    assert.match(r.reason, /Secure Enclave|TPM|hardware/i);
    // considered[] lists the hardware backends as unavailable.
    const enclave = r.considered.find((c) => c.kind === "secure-enclave");
    const tpm = r.considered.find((c) => c.kind === "tpm");
    assert.ok(enclave && enclave.availability.ok === false);
    assert.ok(tpm && tpm.availability.ok === false);
  });

  it("reason is ALWAYS set whenever degraded===true (never a silent downgrade)", () => {
    const r = resolveKeyStore();
    if (r.degraded) assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  });

  it("the AUTO-resolved store signs end-to-end (verifies via identity.ts)", () => {
    const r = resolveKeyStore();
    r.store.create();
    const pem = r.store.publicKeyPem();
    assert.ok(pem);
    const sig = r.store.sign("end-to-end");
    assert.equal(verifySignature("end-to-end", sig, pem), true);
  });

  it("KIT_KEYSTORE=file forces file, NOT degraded", () => {
    process.env.KIT_KEYSTORE = "file";
    const r = resolveKeyStore();
    assert.equal(r.store.kind, "file");
    assert.equal(r.degraded, false);
    assert.equal(r.availability.ok, true);
  });

  it("KIT_KEYSTORE=tpm forces tpm: unavailable, degraded, refuses downgrade, sign() throws", () => {
    process.env.KIT_KEYSTORE = "tpm";
    const r = resolveKeyStore();
    assert.equal(r.store.kind, "tpm");
    assert.equal(r.availability.ok, false);
    assert.equal(r.degraded, true);
    assert.ok(r.reason && /refus/i.test(r.reason), "reason states refusal to downgrade");
    assert.throws(() => r.store.sign("x"));
    // No false green: it is genuinely NOT a file store.
    assert.ok(!(r.store instanceof FileKeyStore));
  });

  it("KIT_KEYSTORE=bogus names the bad value and still returns the file default", () => {
    process.env.KIT_KEYSTORE = "bogus";
    const r = resolveKeyStore();
    assert.equal(r.store.kind, "file");
    assert.ok(r.reason && r.reason.includes("bogus"), "reason names the invalid value");
    assert.match(r.reason, /file|secure-enclave|tpm/, "reason lists the valid set");
  });

  it("is deterministic: two calls yield the same kind", () => {
    const a = resolveKeyStore();
    const b = resolveKeyStore();
    assert.equal(a.store.kind, b.store.kind);
  });

  it("explicit force via opts.force overrides and behaves like the env force", () => {
    const r = resolveKeyStore({ force: "tpm" });
    assert.equal(r.store.kind, "tpm");
    assert.equal(r.degraded, true);
  });
});
