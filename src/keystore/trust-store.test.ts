import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

import {
  recordExternalIdentity,
  readExternalIdentity,
  hasExternalIdentity,
  withExternalTrustRecording,
  EXTERNAL_RECORD_FILE,
} from "./trust-store.js";
import {
  identityId,
  localPublicKeys,
  localRevocationAuthorities,
  loadOrCreateIdentity,
} from "../identity.js";
import { resolveKeyStore } from "./resolve.js";
import type { KeyStore } from "./types.js";

// The behaviour under test is the one that made `kit profile sign` under a hardware backend
// produce a signature `kit profile verify` could not check one second later on the SAME machine:
// nothing ever wrote the external signer's public key into kit's local trust store.

let dir: string;
let saved: string | undefined;

function extKeyPair(): { pub: string; priv: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }) as string,
    priv: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

/** A minimal external store: real public key, sign() counted so we can prove ordering. */
function fakeStore(
  pub: string | null,
  kind: KeyStore["kind"] = "command",
): KeyStore & { signs: number } {
  const store = {
    kind,
    signs: 0,
    available: () => ({ ok: true }),
    publicKeyPem: () => pub,
    sign(_data: Buffer | string) {
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kit-trust-"));
  saved = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = dir;
});

afterEach(() => {
  if (saved === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("recordExternalIdentity", () => {
  it("writes the public record 0600, with no private material in it", () => {
    const { pub, priv } = extKeyPair();
    const kid = recordExternalIdentity(fakeStore(pub));
    assert.equal(kid, identityId(pub));
    const path = join(dir, EXTERNAL_RECORD_FILE);
    assert.equal(existsSync(path), true);
    assert.equal((statSync(path).mode & 0o777).toString(8), "600");
    const text = readFileSync(path, "utf-8");
    assert.ok(
      !text.includes("PRIVATE KEY"),
      "a public trust record must never carry private key material",
    );
    assert.ok(!text.includes(priv.slice(40, 80)), "no fragment of the private PEM");
  });

  it("is a no-op for the file backend (identity.json already holds that key)", () => {
    const { pub } = extKeyPair();
    assert.equal(recordExternalIdentity(fakeStore(pub, "file")), null);
    assert.equal(hasExternalIdentity(), false);
  });

  it("is a no-op when the backend has no public key", () => {
    assert.equal(recordExternalIdentity(fakeStore(null)), null);
    assert.equal(hasExternalIdentity(), false);
  });

  it("is idempotent: the same key does not rewrite the record", () => {
    const { pub } = extKeyPair();
    recordExternalIdentity(fakeStore(pub));
    const first = readFileSync(join(dir, EXTERNAL_RECORD_FILE), "utf-8");
    recordExternalIdentity(fakeStore(pub));
    assert.equal(readFileSync(join(dir, EXTERNAL_RECORD_FILE), "utf-8"), first);
  });

  it("a NEW external key replaces the record (the operator re-provisioned)", () => {
    const a = extKeyPair();
    const b = extKeyPair();
    recordExternalIdentity(fakeStore(a.pub));
    recordExternalIdentity(fakeStore(b.pub));
    assert.equal(readExternalIdentity()?.id, identityId(b.pub));
  });

  it("never throws when the public key is unreadable", () => {
    const store = fakeStore(null);
    store.publicKeyPem = () => {
      throw new Error("hardware unplugged");
    };
    assert.equal(recordExternalIdentity(store), null);
  });
});

describe("readExternalIdentity", () => {
  it("returns null when absent", () => {
    assert.equal(readExternalIdentity(), null);
  });

  it("rejects a record whose kid is not the fingerprint of its public key", () => {
    // The poisoning attempt: claim a victim's kid while supplying your own key. If this were
    // trusted, a planted record could nominate itself as the revoker of a real signer.
    const { pub } = extKeyPair();
    writeFileSync(
      join(dir, EXTERNAL_RECORD_FILE),
      JSON.stringify({ id: "kid_deadbeef", algo: "ed25519", publicKey: pub, backend: "command" }),
    );
    assert.equal(readExternalIdentity(), null);
  });

  it("rejects malformed JSON and missing fields without throwing", () => {
    for (const body of ["{", "null", "[]", '{"id":"kid_x"}', '{"publicKey":"nope"}']) {
      writeFileSync(join(dir, EXTERNAL_RECORD_FILE), body);
      assert.equal(readExternalIdentity(), null, body);
    }
  });
});

describe("the external record joins the LOCAL trust store", () => {
  it("localPublicKeys resolves the external kid — this is what makes verify work", () => {
    const { pub } = extKeyPair();
    recordExternalIdentity(fakeStore(pub));
    assert.equal(localPublicKeys().get(identityId(pub)), pub);
  });

  it("localRevocationAuthorities includes the external kid", () => {
    // Without this, migrate's revocation (signed BY the hardware key) is rejected as coming
    // from an unauthorized revoker, and the revoked file key keeps verifying as valid.
    const { pub } = extKeyPair();
    loadOrCreateIdentity();
    recordExternalIdentity(fakeStore(pub));
    const authorities = localRevocationAuthorities();
    assert.equal(authorities.has(identityId(pub)), true, "external key is a local authority");
    assert.equal(authorities.size, 2, "the file identity remains an authority too");
  });

  it("a poisoned record grants no trust and no authority", () => {
    const { pub } = extKeyPair();
    loadOrCreateIdentity();
    writeFileSync(
      join(dir, EXTERNAL_RECORD_FILE),
      JSON.stringify({ id: "kid_deadbeef", algo: "ed25519", publicKey: pub, backend: "command" }),
    );
    assert.equal(localPublicKeys().has("kid_deadbeef"), false);
    assert.equal(localRevocationAuthorities().has("kid_deadbeef"), false);
  });
});

describe("withExternalTrustRecording", () => {
  it("records on a successful sign, and returns the signature untouched", () => {
    const { pub } = extKeyPair();
    const inner = fakeStore(pub);
    const wrapped = withExternalTrustRecording(inner);
    const sig = wrapped.sign("data");
    assert.equal(sig.toString(), "sig");
    assert.equal(inner.signs, 1);
    assert.equal(readExternalIdentity()?.id, identityId(pub));
  });

  it("records NOTHING when the sign throws — no claim without a signature", () => {
    const { pub } = extKeyPair();
    const inner = fakeStore(pub);
    inner.sign = () => {
      throw new Error("touch not confirmed");
    };
    assert.throws(() => withExternalTrustRecording(inner).sign("x"));
    assert.equal(hasExternalIdentity(), false);
  });

  it("returns the file backend unwrapped (no behaviour change for the default)", () => {
    const inner = fakeStore(extKeyPair().pub, "file");
    assert.equal(withExternalTrustRecording(inner), inner);
  });

  it("is WIRED INTO resolveKeyStore — a real command backend records on sign", () => {
    // The wrapper being correct is not the same as it being installed. This drives the actual
    // resolver with a real external signer, which is the path `kit profile sign` takes.
    const { pub, priv } = extKeyPair();
    const pubPath = join(dir, "pub.pem");
    const privPath = join(dir, "priv.pem");
    const signer = join(dir, "sign.mjs");
    writeFileSync(pubPath, pub);
    writeFileSync(privPath, priv, { mode: 0o600 });
    writeFileSync(
      signer,
      `import { readFileSync } from "node:fs";\n` +
        `import { sign, createPrivateKey } from "node:crypto";\n` +
        `process.stdout.write(sign(null, readFileSync(0), createPrivateKey(readFileSync(${JSON.stringify(privPath)}, "utf-8"))).toString("base64"));\n`,
    );
    const savedEnv = {
      KIT_KEYSTORE: process.env.KIT_KEYSTORE,
      KIT_KEYSTORE_SIGN_CMD: process.env.KIT_KEYSTORE_SIGN_CMD,
      KIT_KEYSTORE_PUBKEY: process.env.KIT_KEYSTORE_PUBKEY,
    };
    process.env.KIT_KEYSTORE = "command";
    process.env.KIT_KEYSTORE_SIGN_CMD = `${process.execPath} ${signer}`;
    process.env.KIT_KEYSTORE_PUBKEY = pubPath;
    try {
      const res = resolveKeyStore();
      assert.equal(res.store.kind, "command");
      assert.equal(hasExternalIdentity(), false, "resolving alone must not write anything");
      res.store.sign("payload");
      assert.equal(readExternalIdentity()?.id, identityId(pub), "signing records the signer");
      assert.equal(
        localPublicKeys().get(identityId(pub)),
        pub,
        "and the local trust store can now verify what kit just signed",
      );
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("passes kind / available / publicKeyPem through", () => {
    const { pub } = extKeyPair();
    const wrapped = withExternalTrustRecording(fakeStore(pub));
    assert.equal(wrapped.kind, "command");
    assert.deepEqual(wrapped.available(), { ok: true });
    assert.equal(wrapped.publicKeyPem(), pub);
  });
});
