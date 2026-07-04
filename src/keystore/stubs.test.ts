/**
 * The hardware stubs are HONEST on EVERY platform: available().ok===false with a
 * meaningful reason (no false green regardless of where CI runs), and every
 * key-touching operation fails closed with that reason.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SecureEnclaveKeyStore } from "./secure-enclave-store.js";
import { TpmKeyStore } from "./tpm-store.js";

describe("hardware keystore stubs (honest, fail-closed)", () => {
  it("SecureEnclaveKeyStore is never available and names macOS/Secure Enclave", () => {
    const store = new SecureEnclaveKeyStore();
    assert.equal(store.kind, "secure-enclave");
    const a = store.available();
    assert.equal(a.ok, false, "must never fake success");
    assert.equal(typeof a.reason, "string");
    assert.ok(a.reason && a.reason.length > 0);
    assert.match(a.reason, /macOS|darwin|Secure Enclave/i);
    assert.equal(store.publicKeyPem(), null);
    assert.throws(() => store.sign("x"), /Enclave|macOS|darwin/i);
    assert.throws(() => store.create(), /Enclave|macOS|darwin/i);
    assert.throws(() => store.rotate(), /Enclave|macOS|darwin/i);
  });

  it("TpmKeyStore is never available and names TPM", () => {
    const store = new TpmKeyStore();
    assert.equal(store.kind, "tpm");
    const a = store.available();
    assert.equal(a.ok, false, "must never fake success");
    assert.equal(typeof a.reason, "string");
    assert.ok(a.reason && a.reason.length > 0);
    assert.match(a.reason, /TPM/i);
    assert.equal(store.publicKeyPem(), null);
    assert.throws(() => store.sign("x"), /TPM/i);
    assert.throws(() => store.create(), /TPM/i);
    assert.throws(() => store.rotate(), /TPM/i);
  });
});
