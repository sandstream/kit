import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { cmdIdentity } from "./identity.js";
import { loadOrCreateIdentity, isRevoked } from "../identity.js";
import { resolveKeyStore } from "../keystore/resolve.js";
import { runDoctor } from "../doctor.js";

// `kit identity migrate` must FAIL CLOSED unless an external/hardware keystore is
// actually active — it revokes the old file key, so running it while still on the
// file backend (the default) would be meaningless and must refuse. The happy path
// (revocation signed by the active hardware key) is covered by the keystore suite's
// keystoreRecordRevocation tests; here we lock the safety guard.
describe("kit identity migrate", () => {
  const savedArgv = process.argv;
  const savedKs = process.env.KIT_KEYSTORE;

  before(() => {
    delete process.env.KIT_KEYSTORE; // force the file backend (not hardware-rooted)
  });
  after(() => {
    process.argv = savedArgv;
    if (savedKs === undefined) delete process.env.KIT_KEYSTORE;
    else process.env.KIT_KEYSTORE = savedKs;
  });

  it("fails closed when no external/hardware backend is active", async () => {
    process.argv = ["node", "kit", "identity", "migrate"];
    const ok = await cmdIdentity();
    assert.equal(ok, false, "migrate must refuse to run on the file backend");
  });
});

/**
 * End-to-end on the claim README pillar 1 makes: migrate "revokes the old key". It used to write
 * a revocation record and change NOTHING — the revoked file key kept signing profiles and
 * policies, `kit identity show` looked healthy, and `kit doctor` said nothing. The record was not
 * authoritative because the revoker (the new hardware key) was unknown to the local trust store.
 */
describe("kit identity migrate — end to end with a real external backend", () => {
  const savedArgv = process.argv;
  const savedEnv = { ...process.env };
  let dir: string;
  let hw: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-mig-id-"));
    hw = mkdtempSync(join(tmpdir(), "kit-mig-hw-"));
    process.env.KIT_IDENTITY_DIR = dir;
    delete process.env.KIT_KEYSTORE;
  });
  after(() => {
    process.argv = savedArgv;
    for (const k of [
      "KIT_IDENTITY_DIR",
      "KIT_KEYSTORE",
      "KIT_KEYSTORE_SIGN_CMD",
      "KIT_KEYSTORE_PUBKEY",
    ]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(hw, { recursive: true, force: true });
  });

  it("revokes the old file key, and the revocation actually bites", async () => {
    // 1. a file identity, healthy and able to sign.
    const { identity: fileId } = loadOrCreateIdentity();
    assert.equal(isRevoked(fileId.id), false);
    assert.doesNotThrow(() => resolveKeyStore().store.sign("before"));

    // 2. the operator provisions a key kit never holds and points kit at it.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubPath = join(hw, "pub.pem");
    const privPath = join(hw, "priv.pem");
    const signer = join(hw, "sign.mjs");
    writeFileSync(pubPath, publicKey.export({ type: "spki", format: "pem" }) as string);
    writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string, {
      mode: 0o600,
    });
    writeFileSync(
      signer,
      `import { readFileSync } from "node:fs";\n` +
        `import { sign, createPrivateKey } from "node:crypto";\n` +
        `process.stdout.write(sign(null, readFileSync(0), createPrivateKey(readFileSync(${JSON.stringify(privPath)}, "utf-8"))).toString("base64"));\n`,
    );
    process.env.KIT_KEYSTORE = "command";
    process.env.KIT_KEYSTORE_SIGN_CMD = `${process.execPath} ${signer}`;
    process.env.KIT_KEYSTORE_PUBKEY = pubPath;

    // 3. migrate.
    process.argv = ["node", "kit", "identity", "migrate"];
    assert.equal(await cmdIdentity(), true);

    // 4. the revocation is AUTHORITATIVE under the local trust context — not just recorded.
    assert.equal(
      isRevoked(fileId.id),
      true,
      "a recorded revocation that nothing honors is not a revocation",
    );

    // 5. …so the old key can no longer sign, even after the hardware env goes away (a new shell
    //    without KIT_KEYSTORE set is exactly when the old key would otherwise come back).
    delete process.env.KIT_KEYSTORE;
    delete process.env.KIT_KEYSTORE_SIGN_CMD;
    delete process.env.KIT_KEYSTORE_PUBKEY;
    assert.equal(resolveKeyStore().store.kind, "file");
    assert.throws(() => resolveKeyStore().store.sign("after"), /REVOKED/);

    // 6. and the operator is told, rather than left with a healthy-looking identity.
    const check = (await runDoctor({}, process.cwd())).checks.find(
      (c) => c.name === "identity keystore",
    );
    assert.equal(check?.status, "fail");
    assert.match(check?.detail ?? "", /REVOKED/);
  });
});
