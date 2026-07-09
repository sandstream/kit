import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cmdIdentity } from "./identity.js";

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
