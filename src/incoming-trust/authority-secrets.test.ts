import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { it } from "node:test";
import { storeFixture } from "./authority-store.test-support.js";

it("refuses a public PEM bundle that also contains a private signing key", () => {
  const f = storeFixture();
  try {
    f.proof.authority.signers[0].publicKeyPem += f.proof.keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    assert.throws(
      () => f.store.update(f.repository, { type: "enroll", authority: f.proof.authority }),
      /invalid-authority/,
    );
    assert.equal(existsSync(f.directory), false, "a rejected private key must never reach storage");
  } finally {
    f.cleanup();
  }
});

it("accepts a standalone public key with Windows line endings", () => {
  const f = storeFixture();
  try {
    f.proof.authority.signers[0].publicKeyPem =
      f.proof.authority.signers[0].publicKeyPem.replaceAll("\n", "\r\n");
    const enrolled = f.store.update(f.repository, { type: "enroll", authority: f.proof.authority });
    assert.deepEqual(f.store.read(f.repository), enrolled);
  } finally {
    f.cleanup();
  }
});
