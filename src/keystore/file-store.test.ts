/**
 * FileKeyStore faithfully WRAPS ../identity.js. Proves pure delegation, not a
 * re-implementation: signatures verify via identity.ts verifySignature, rotation
 * archives keep resolving via localPublicKeys(), and create() is idempotent.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifySignature, localPublicKeys } from "../identity.js";
import { FileKeyStore } from "./file-store.js";

describe("FileKeyStore", () => {
  let dir: string;
  const prev = process.env.KIT_IDENTITY_DIR;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-keystore-file-"));
    process.env.KIT_IDENTITY_DIR = dir;
  });
  after(() => {
    if (prev === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  it("is available and reports kind 'file'", () => {
    const store = new FileKeyStore();
    assert.equal(store.kind, "file");
    assert.equal(store.available().ok, true);
  });

  it("publicKeyPem() is null before create()", () => {
    const store = new FileKeyStore();
    assert.equal(store.publicKeyPem(), null);
  });

  it("create() creates then is idempotent (delegates to loadOrCreateIdentity)", () => {
    const store = new FileKeyStore();
    const first = store.create();
    assert.equal(first.created, true);
    assert.match(first.identity.id, /^kid_[0-9a-f]{32}$/);
    const second = store.create();
    assert.equal(second.created, false);
    assert.equal(second.identity.id, first.identity.id);
    assert.ok(store.publicKeyPem()?.includes("BEGIN PUBLIC KEY"));
  });

  it("sign() output verifies via identity.ts against publicKeyPem(); tamper fails", () => {
    const store = new FileKeyStore();
    store.create();
    const pem = store.publicKeyPem();
    assert.ok(pem);
    const msg = "provenance statement";
    const sig = store.sign(msg);
    assert.equal(verifySignature(msg, sig, pem), true);
    // Asymmetric + fail-closed: a tampered message must not verify.
    assert.equal(verifySignature("provenance statemenX", sig, pem), false);
  });

  it("rotate() yields a new id + previousId, and the rotated-away key still resolves", () => {
    const store = new FileKeyStore();
    const before = store.create().identity;
    const rot = store.rotate();
    assert.notEqual(rot.identity.id, before.id, "rotation must mint a new key");
    assert.equal(rot.previousId, before.id, "previousId is the archived key");
    // Delegation intact: localPublicKeys() still knows the rotated-away key.
    const known = localPublicKeys();
    assert.ok(known.has(before.id), "archived public key must remain resolvable");
    assert.ok(known.has(rot.identity.id), "new public key must be resolvable");
  });
});
