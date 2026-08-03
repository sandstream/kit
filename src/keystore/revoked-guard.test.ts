import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withRevocationRefusal, storeKeyIsRevoked } from "./revoked-guard.js";
import { resolveKeyStore } from "./resolve.js";
import {
  loadOrCreateIdentity,
  recordRevocation,
  appendRevocations,
  isRevoked,
  identityId,
} from "../identity.js";
import type { KeyStore } from "./types.js";

// `kit identity migrate` revokes the old file key. Before this guard, that revocation changed
// nothing: the revoked key went on signing profiles, policies and audit entries, and `kit doctor`
// reported a healthy identity. These tests pin the refusal.

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-revguard-"));
  saved = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = dir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

function counting(pub: string | null): KeyStore & { signs: number } {
  const store = {
    kind: "file" as const,
    signs: 0,
    available: () => ({ ok: true }),
    publicKeyPem: () => pub,
    sign(_d: Buffer | string) {
      store.signs++;
      return Buffer.from("sig");
    },
    create: () => {
      throw new Error("not used");
    },
    rotate: () => {
      throw new Error("not used");
    },
  };
  return store as KeyStore & { signs: number };
}

describe("storeKeyIsRevoked", () => {
  it("false for a fresh identity", () => {
    const { identity } = loadOrCreateIdentity();
    assert.equal(isRevoked(identity.id), false);
    assert.equal(storeKeyIsRevoked(resolveKeyStore().store), false);
  });

  it("true once the active key is self-revoked", () => {
    const { identity } = loadOrCreateIdentity();
    recordRevocation(identity.id, "test");
    assert.equal(storeKeyIsRevoked(resolveKeyStore().store), true);
  });

  it("false when there is no key at all (nothing to be revoked)", () => {
    assert.equal(storeKeyIsRevoked(counting(null)), false);
  });
});

describe("withRevocationRefusal", () => {
  it("signs normally while the key is not revoked", () => {
    const { identity } = loadOrCreateIdentity();
    const inner = counting(identity.publicKey);
    assert.equal(withRevocationRefusal(inner).sign("x").toString(), "sig");
    assert.equal(inner.signs, 1);
  });

  it("REFUSES to sign a revoked key, and never calls through", () => {
    const { identity } = loadOrCreateIdentity();
    recordRevocation(identity.id, "migrated to hardware-rooted identity");
    const inner = counting(identity.publicKey);
    assert.throws(() => withRevocationRefusal(inner).sign("x"), /REVOKED/);
    assert.equal(inner.signs, 0, "the underlying key must never be used");
  });

  it("the refusal names the kid and the way out", () => {
    const { identity } = loadOrCreateIdentity();
    recordRevocation(identity.id, "test");
    assert.throws(
      () => withRevocationRefusal(counting(identity.publicKey)).sign("x"),
      (e: Error) => {
        assert.match(e.message, new RegExp(identity.id));
        assert.match(e.message, /rotate|KIT_KEYSTORE/);
        return true;
      },
    );
  });

  it("READ paths still work on a revoked identity — doctor has to be able to report it", () => {
    const { identity } = loadOrCreateIdentity();
    recordRevocation(identity.id, "test");
    const wrapped = withRevocationRefusal(counting(identity.publicKey));
    assert.equal(wrapped.publicKeyPem(), identity.publicKey);
    assert.deepEqual(wrapped.available(), { ok: true });
    assert.equal(identityId(wrapped.publicKeyPem()!), identity.id);
  });

  it("an unauthoritative revocation record does NOT block signing (no unsigned-record DoS)", () => {
    // A record with a bogus signature must not be honored — otherwise anyone able to append a
    // line to revocations.jsonl could stop kit signing without holding any key.
    const { identity } = loadOrCreateIdentity();
    appendRevocations([
      {
        kid: identity.id,
        reason: "forged",
        ts: new Date().toISOString(),
        by: identity.id,
        sig: "AAAA",
      },
    ]);
    assert.equal(
      isRevoked(identity.id),
      false,
      "a bad signature is not an authoritative revocation",
    );
    const inner = counting(identity.publicKey);
    assert.equal(withRevocationRefusal(inner).sign("x").toString(), "sig");
  });
});

describe("resolveKeyStore wires the guard (so every sign path has it)", () => {
  it("the resolved store refuses after the active key is revoked", () => {
    const { identity } = loadOrCreateIdentity();
    recordRevocation(identity.id, "migrated");
    assert.throws(() => resolveKeyStore().store.sign("x"), /REVOKED/);
  });
});
