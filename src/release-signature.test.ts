import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { Readable } from "node:stream";
import { checkSignatures, type SignedFile } from "./release-signature.js";

const DATA = Buffer.from("release bytes");

function minisignPair(): { pub: string; key: KeyObject; id: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const id = Buffer.from("0123456789abcdef", "hex");
  const raw = Buffer.concat([Buffer.from("Ed"), id, x]).toString("base64");
  return { pub: `untrusted comment: minisign public key\n${raw}\n`, key: privateKey, id };
}

function minisig(data: Buffer, key: KeyObject, id: Buffer, trusted = "timestamp:1"): string {
  const sig = sign(null, createHash("blake2b512").update(data).digest(), key);
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), key);
  const line = Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64");
  return `untrusted comment: sig\n${line}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
}

const file = (signatures: Record<string, string>, data = DATA): SignedFile => ({
  label: "tool.tgz",
  bytes: () => Readable.from([data]),
  signatures,
});

describe("release signatures", () => {
  it("verifies minisign with the user's key, and fails another key or other bytes", async () => {
    const { pub, key, id } = minisignPair();
    const signed = file({ ".minisig": minisig(DATA, key, id) });
    assert.equal((await checkSignatures([signed], { minisignKey: pub })).status, "pass");
    const other = minisignPair().pub;
    assert.equal((await checkSignatures([signed], { minisignKey: other })).status, "fail");
    const tampered = file({ ".minisig": minisig(DATA, key, id) }, Buffer.from("other"));
    assert.equal((await checkSignatures([tampered], { minisignKey: pub })).status, "fail");
  });

  it("verifies a cosign key signature on a later file (the checksum list), and fails a wrong one", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const sig = sign("sha256", DATA, privateKey).toString("base64");
    const r = await checkSignatures([file({}), file({ ".sig": sig })], { cosignKey: pem });
    assert.equal(r.status, "pass", r.detail);
    const bad = sign("sha256", Buffer.from("x"), privateKey).toString("base64");
    assert.equal(
      (await checkSignatures([file({ ".sig": bad })], { cosignKey: pem })).status,
      "fail",
    );
  });

  it("is unverified for OpenPGP or no key, and fails a key with no signature", async () => {
    const asc = await checkSignatures([file({ ".asc": "-----BEGIN PGP SIGNATURE-----" })], {});
    assert.equal(asc.status, "unverified");
    assert.match(asc.detail, /OpenPGP/);
    assert.equal((await checkSignatures([file({})], {})).status, "unverified");
    const keyOnly = await checkSignatures([file({})], { minisignKey: minisignPair().pub });
    assert.equal(keyOnly.status, "fail");
  });
});
