import assert from "node:assert/strict";
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  scryptSync,
} from "node:crypto";
import fs, { readFileSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { it } from "node:test";
import {
  generateMemoryKeypair,
  restoreEncrypted,
  restoreWithKey,
  type MemoryKeyJwk,
} from "./backup.js";
import { fixture, passphrase, restoreMocks } from "./backup.test-support.js";

function encryptLegacyV2(plaintext: Buffer): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, {
    N: 1 << 17,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(plaintext)), cipher.final()]);
  return Buffer.concat([Buffer.from("KITMEM02"), salt, iv, cipher.getAuthTag(), ciphertext]);
}

function encryptLegacyV3(plaintext: Buffer, recipient: MemoryKeyJwk): Buffer {
  const { publicKey: ephemeralPublic, privateKey: ephemeralPrivate } =
    generateKeyPairSync("x25519");
  const ephemeral = Buffer.from(
    (ephemeralPublic.export({ format: "jwk" }) as { x: string }).x,
    "base64url",
  );
  const recipientRaw = Buffer.from(recipient.x, "base64url");
  const recipientPublic = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: recipient.x },
    format: "jwk",
  });
  const shared = diffieHellman({ privateKey: ephemeralPrivate, publicKey: recipientPublic });
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.concat([ephemeral, recipientRaw]),
      Buffer.from("kit-memory-v3"),
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(plaintext)), cipher.final()]);
  return Buffer.concat([Buffer.from("KITMEM03"), ephemeral, iv, cipher.getAuthTag(), ciphertext]);
}

const legacyRecipient = generateMemoryKeypair();

for (const legacy of [
  {
    name: "V2 passphrase",
    encrypt: (plaintext: Buffer) => encryptLegacyV2(plaintext),
    restore: (blob: string, dest: string) => restoreEncrypted(passphrase, blob, dest),
  },
  {
    name: "V3 recipient",
    encrypt: (plaintext: Buffer) => encryptLegacyV3(plaintext, legacyRecipient.privateJwk),
    restore: (blob: string, dest: string) => restoreWithKey(legacyRecipient.privateJwk, blob, dest),
  },
]) {
  it(`${legacy.name}: restore compatibility never reads a large legacy blob whole`, (t) => {
    const files = fixture(t);
    const source = new DatabaseSync(files.src);
    try {
      source.exec("CREATE TABLE payload (value BLOB)");
      source.prepare("INSERT INTO payload VALUES (?)").run(randomBytes(2 * 1024 * 1024));
    } finally {
      source.close();
    }
    const plaintext = readFileSync(files.src);
    writeFileSync(files.blob, legacy.encrypt(plaintext));
    assert.ok(statSync(files.blob).size > 512 * 1024, "fixture must exercise a large blob");

    const readFile = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof readFile>) => {
      const path = args[0];
      if (
        typeof path === "string" &&
        (statSync(path, { throwIfNoEntry: false })?.size ?? 0) > 512 * 1024
      ) {
        throw new Error("whole-file read refused by legacy resource contract");
      }
      return readFile(...args);
    });
    syncBuiltinESMExports();
    try {
      legacy.restore(files.blob, files.dest);
    } finally {
      restoreMocks(t);
    }

    const restored = new DatabaseSync(files.dest, { readOnly: true });
    try {
      assert.equal(
        restored.prepare("SELECT length(value) AS bytes FROM payload").get()?.bytes,
        2 * 1024 * 1024,
      );
      assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    } finally {
      restored.close();
    }
  });
}
