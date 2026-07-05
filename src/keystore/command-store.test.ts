import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { ExternalCommandKeyStore } from "./command-store.js";
import { identityId, verifySignature } from "../identity.js";

// A tiny external "hardware" signer: reads bytes on stdin, signs with the private key at
// argv[2], prints base64. Stands in for a TPM/HSM/YubiKey command — the private key
// lives OUTSIDE kit's process, exactly the property the backend depends on.
const SIGNER = `const c=require("node:crypto");const fs=require("node:fs");const k=c.createPrivateKey(fs.readFileSync(process.argv[2]));process.stdout.write(c.sign(null,fs.readFileSync(0),k).toString("base64"));`;

function pemPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }) as string,
    priv: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

describe("ExternalCommandKeyStore (hardware-rooted, operator-fronted)", () => {
  let d: string;
  let signerPath: string;
  const saved = { cmd: process.env.KIT_KEYSTORE_SIGN_CMD, pub: process.env.KIT_KEYSTORE_PUBKEY };

  before(() => {
    d = mkdtempSync(join(tmpdir(), "kit-cmdks-"));
    signerPath = join(d, "signer.cjs");
    writeFileSync(signerPath, SIGNER);
  });
  after(() => {
    if (saved.cmd === undefined) delete process.env.KIT_KEYSTORE_SIGN_CMD;
    else process.env.KIT_KEYSTORE_SIGN_CMD = saved.cmd;
    if (saved.pub === undefined) delete process.env.KIT_KEYSTORE_PUBKEY;
    else process.env.KIT_KEYSTORE_PUBKEY = saved.pub;
    rmSync(d, { recursive: true, force: true });
  });

  function configure(pubPem: string, privPemPath: string) {
    process.env.KIT_KEYSTORE_PUBKEY = pubPem;
    process.env.KIT_KEYSTORE_SIGN_CMD = `node ${signerPath} ${privPemPath}`;
  }

  it("is unavailable (honest) until BOTH sign cmd and pubkey are configured", () => {
    delete process.env.KIT_KEYSTORE_SIGN_CMD;
    delete process.env.KIT_KEYSTORE_PUBKEY;
    const ks = new ExternalCommandKeyStore();
    assert.equal(ks.available().ok, false);
    assert.match(ks.available().reason!, /KIT_KEYSTORE_SIGN_CMD/);
    process.env.KIT_KEYSTORE_SIGN_CMD = "true";
    assert.match(ks.available().reason!, /KIT_KEYSTORE_PUBKEY/);
    assert.equal(ks.publicKeyPem(), null);
  });

  it("signs via the external command and the signature verifies against the pubkey", () => {
    const { pub, priv } = pemPair();
    const privPath = join(d, "k1.pem");
    writeFileSync(privPath, priv);
    configure(pub, privPath);

    const ks = new ExternalCommandKeyStore();
    assert.equal(ks.available().ok, true);
    assert.equal(ks.publicKeyPem()!.trim(), pub.trim());
    assert.equal(ks.create().identity.id, identityId(pub));
    assert.equal(ks.create().created, false, "kit never mints a hardware key");

    const data = Buffer.from("policy-canonical-bytes");
    const sig = ks.sign(data);
    assert.equal(verifySignature(data, sig, pub), true, "produced a real, verifying signature");
  });

  it("FAILS CLOSED when the signer returns a signature by the WRONG key (self-verify)", () => {
    const a = pemPair();
    const b = pemPair(); // different key
    const wrongPriv = join(d, "wrong.pem");
    writeFileSync(wrongPriv, b.priv);
    // Advertise a's pubkey but sign with b's key → self-verify must reject.
    configure(a.pub, wrongPriv);
    const ks = new ExternalCommandKeyStore();
    assert.throws(() => ks.sign("x"), /does NOT verify/);
  });

  it("FAILS CLOSED on a non-zero exit and on empty output", () => {
    const { pub } = pemPair();
    process.env.KIT_KEYSTORE_PUBKEY = pub;
    process.env.KIT_KEYSTORE_SIGN_CMD = 'node -e "process.exit(3)"';
    assert.throws(() => new ExternalCommandKeyStore().sign("x"), /failed/);
    process.env.KIT_KEYSTORE_SIGN_CMD = 'node -e "0"'; // prints nothing
    assert.throws(() => new ExternalCommandKeyStore().sign("x"), /no signature/);
  });

  it("does NOT leak kit's secrets (KIT_*) into the signer subprocess", () => {
    const { pub, priv } = pemPair();
    const privPath = join(d, "k-env.pem");
    writeFileSync(privPath, priv);
    // A signer that records what it saw for KIT_SUPERSECRET, then signs normally.
    const leakFile = join(d, "leaked.txt");
    const spy = join(d, "spy.cjs");
    writeFileSync(
      spy,
      `const c=require("node:crypto");const fs=require("node:fs");` +
        `fs.writeFileSync(${JSON.stringify(leakFile)}, process.env.KIT_SUPERSECRET ?? "ABSENT");` +
        `const k=c.createPrivateKey(fs.readFileSync(process.argv[2]));` +
        `process.stdout.write(c.sign(null,fs.readFileSync(0),k).toString("base64"));`,
    );
    process.env.KIT_KEYSTORE_PUBKEY = pub;
    process.env.KIT_KEYSTORE_SIGN_CMD = `node ${spy} ${privPath}`;
    process.env.KIT_SUPERSECRET = "vault-token-do-not-leak";
    try {
      const sig = new ExternalCommandKeyStore().sign("data");
      assert.equal(verifySignature("data", sig, pub), true);
      assert.equal(
        readFileSync(leakFile, "utf-8"),
        "ABSENT",
        "the signer must NOT receive kit's KIT_* env secrets",
      );
    } finally {
      delete process.env.KIT_SUPERSECRET;
    }
  });

  it("rotate() refuses — a hardware key is rotated out of band", () => {
    const { pub } = pemPair();
    process.env.KIT_KEYSTORE_PUBKEY = pub;
    process.env.KIT_KEYSTORE_SIGN_CMD = "true";
    assert.throws(() => new ExternalCommandKeyStore().rotate(), /out of band/);
  });
});
