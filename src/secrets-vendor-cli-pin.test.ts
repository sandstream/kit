/**
 * Use-time enforcement of the vendor-CLI pin on the secret paths (kit-research#232): checkSecrets,
 * the backends' resolveViaBackend and the 1Password expiry probe refuse a pinned CLI that changed,
 * without running it, and run it again once `--accept` re-trusted it. Fake CLIs only.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { pinOne } from "./commands/tools-pin.js";
import { checkSecrets } from "./check-secrets.js";
import { resolveViaBackend } from "./secret-backends.js";
import { get1PasswordExpiration } from "./secret-expiration.js";
import { makeFixture, opStub, POSIX_ONLY, type Fixture } from "./vendor-cli-pin.test-support.js";

describe("vendor-CLI pin at use time on the secret paths", { skip: POSIX_ONLY }, () => {
  let f: Fixture;
  let restore: () => void;
  const cwd = process.cwd();
  // The fake `op` doubles as `doppler`: it logs its argv, which is what these tests read.
  const asDoppler = () => copyFileSync(join(f.bin, "op"), join(f.bin, "doppler"));
  const tamper = () => {
    f.writeOp(f.bin, opStub("2.30.0", "tampered"));
    asDoppler();
    f.clearLog();
  };

  beforeEach(async () => {
    f = makeFixture();
    asDoppler();
    process.env.PATH = f.bin;
    process.chdir(f.proj);
    for (const t of ["op", "doppler"])
      assert.equal((await pinOne(t, false, f.deps, f.io)).result, "pinned");
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    restore = () => (process.stderr.write = write);
  });

  afterEach(() => {
    restore();
    process.chdir(cwd);
    f.done();
  });

  it("checkSecrets: a tampered doppler is never run, and the process exits non-zero", async () => {
    tamper();
    const r = await checkSecrets({ keys: { K: { source: "doppler", name: "K" } } }, f.proj);
    assert.equal(r.keys[0]!.available, false);
    assert.equal(f.logged(), "");
    assert.equal(process.exitCode, 1);
  });

  it("resolveViaBackend: refused before `doppler secrets get`; accept re-enables it", async () => {
    tamper();
    assert.equal((await resolveViaBackend("K", { source: "doppler", name: "K" })).resolved, false);
    assert.equal(f.logged(), "");
    process.exitCode = 0;
    assert.equal((await pinOne("doppler", true, f.deps, f.io)).result, "accepted");
    await resolveViaBackend("K", { source: "doppler", name: "K" });
    assert.match(f.logged(), /^secrets get K --plain$/m);
  });

  it("1Password: neither the status probe, `op read` nor `op item get` runs a tampered op", async () => {
    tamper();
    const keys = { K: { source: "1password" as const, ref: "op://Dev/item/f" } };
    assert.equal(
      (await checkSecrets({ store: "1password", keys }, f.proj)).keys[0]!.available,
      false,
    );
    assert.equal(await get1PasswordExpiration("op://Dev/item/f"), null);
    assert.equal(f.logged(), "");
    assert.equal(process.exitCode, 1);
  });
});
