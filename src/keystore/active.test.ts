import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  isHardwareRooted,
  hardwareRequiredByEnv,
  assertHardwareIdentity,
  keystoreSign,
  activeKeyStoreStatus,
} from "./active.js";
import { resolveKeyStore } from "./resolve.js";
import { loadOrCreateIdentity, verifySignature } from "../identity.js";

const SIGNER = `const c=require("node:crypto");const fs=require("node:fs");const k=c.createPrivateKey(fs.readFileSync(process.argv[2]));process.stdout.write(c.sign(null,fs.readFileSync(0),k).toString("base64"));`;

describe("keystore/active — hardware enforcement + signing facade", () => {
  let d: string;
  let signerPath: string;
  const saved = {
    ks: process.env.KIT_KEYSTORE,
    cmd: process.env.KIT_KEYSTORE_SIGN_CMD,
    pub: process.env.KIT_KEYSTORE_PUBKEY,
    req: process.env.KIT_REQUIRE_HARDWARE_IDENTITY,
    id: process.env.KIT_IDENTITY_DIR,
  };

  before(() => {
    d = mkdtempSync(join(tmpdir(), "kit-active-"));
    signerPath = join(d, "signer.cjs");
    writeFileSync(signerPath, SIGNER);
  });
  after(() => {
    for (const [k, v] of Object.entries({
      KIT_KEYSTORE: saved.ks,
      KIT_KEYSTORE_SIGN_CMD: saved.cmd,
      KIT_KEYSTORE_PUBKEY: saved.pub,
      KIT_REQUIRE_HARDWARE_IDENTITY: saved.req,
      KIT_IDENTITY_DIR: saved.id,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.KIT_KEYSTORE;
    delete process.env.KIT_KEYSTORE_SIGN_CMD;
    delete process.env.KIT_KEYSTORE_PUBKEY;
    delete process.env.KIT_REQUIRE_HARDWARE_IDENTITY;
    process.env.KIT_IDENTITY_DIR = mkdtempSync(join(tmpdir(), "kit-active-id-"));
  });
  afterEach(() => {
    rmSync(process.env.KIT_IDENTITY_DIR!, { recursive: true, force: true });
  });

  function configureCommand(): void {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privPath = join(d, `k-${Math.random().toString(36).slice(2)}.pem`);
    writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
    process.env.KIT_KEYSTORE = "command";
    process.env.KIT_KEYSTORE_PUBKEY = publicKey.export({ type: "spki", format: "pem" }) as string;
    process.env.KIT_KEYSTORE_SIGN_CMD = `node ${signerPath} ${privPath}`;
  }

  it("hardwareRequiredByEnv parses the mandate flag", () => {
    assert.equal(hardwareRequiredByEnv(), false);
    for (const v of ["1", "true", "YES", "on"]) {
      process.env.KIT_REQUIRE_HARDWARE_IDENTITY = v;
      assert.equal(hardwareRequiredByEnv(), true, v);
    }
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "0";
    assert.equal(hardwareRequiredByEnv(), false);
  });

  it("the file backend is NOT hardware-rooted; a configured command backend IS", () => {
    assert.equal(isHardwareRooted(resolveKeyStore()), false); // AUTO → file
    configureCommand();
    assert.equal(isHardwareRooted(resolveKeyStore()), true);
  });

  it("assertHardwareIdentity fails closed on file when required, no-op otherwise", () => {
    const fileRes = resolveKeyStore();
    assert.doesNotThrow(() => assertHardwareIdentity(fileRes, false));
    assert.throws(
      () => assertHardwareIdentity(fileRes, true),
      /hardware-rooted identity is REQUIRED/,
    );
    configureCommand();
    assert.doesNotThrow(() => assertHardwareIdentity(resolveKeyStore(), true));
  });

  it("keystoreSign: file default signs; required+file throws; command signs & verifies", () => {
    // Default (file, not required): signs like the file identity.
    const id = loadOrCreateIdentity().identity;
    const data = Buffer.from("attest");
    const sig = keystoreSign(data);
    assert.equal(verifySignature(data, sig, id.publicKey), true);
    // Required but only file available → fail closed.
    assert.throws(() => keystoreSign(data, { required: true }), /REQUIRED/);
    // Command backend: signs through the external signer and verifies.
    configureCommand();
    const pub = process.env.KIT_KEYSTORE_PUBKEY!;
    const sig2 = keystoreSign(data, { required: true });
    assert.equal(verifySignature(data, sig2, pub), true);
  });

  it("activeKeyStoreStatus reports the honest backend + kid", () => {
    const fileSt = activeKeyStoreStatus();
    assert.equal(fileSt.kind, "file");
    assert.equal(fileSt.hardwareRooted, false);
    assert.ok(fileSt.reason && /same-UID/.test(fileSt.reason));
    configureCommand();
    const cmdSt = activeKeyStoreStatus();
    assert.equal(cmdSt.kind, "command");
    assert.equal(cmdSt.hardwareRooted, true);
    assert.match(cmdSt.kid!, /^kid_[0-9a-f]{32}$/);
  });
});
