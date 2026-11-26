/**
 * The `vendor CLI: <tool>` check row (kit-research#232): pass, fail on a same-version hash change,
 * warn on a new version, on PATH shadowing and when unpinned, skip with no vendor CLI.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { checkVendorCliPins } from "./check-vendor-cli-pin.js";
import { measureCli } from "./vendor-cli-pin.js";
import { pinOne } from "./commands/tools-pin.js";
import { makeFixture, opStub, POSIX_ONLY, type Fixture } from "./vendor-cli-pin.test-support.js";

describe("vendor CLI check row", { skip: POSIX_ONLY }, () => {
  let f: Fixture;
  const rows = () => checkVendorCliPins(f.proj, { store: "1password" }, f.deps);
  const pinned = async () =>
    assert.equal((await pinOne("op", false, f.deps, f.io)).result, "pinned");

  beforeEach(() => (f = makeFixture()));
  afterEach(() => f.done());

  it("nothing pinned: warn with the exact pin command; no vendor CLI at all: skip", async () => {
    const [r] = await rows();
    assert.equal(r!.status, "warn");
    assert.match(r!.detail, /unpinned: kit runs whatever op is first on PATH/);
    assert.equal(r!.suggestion, "kit tools pin op");
    const none = await checkVendorCliPins(f.proj, { store: "env" }, f.deps);
    assert.deepEqual(
      none.map((n) => n.status),
      ["skip"],
    );
  });

  it("unchanged: pass with the pinned version, and the binary is never run", async () => {
    await pinned();
    f.clearLog();
    const [r] = await rows();
    assert.equal(r!.status, "pass");
    assert.match(r!.detail, /op 2\.30\.0 matches its pin/);
    assert.equal(f.logged(), "");
  });

  it("hash changed, version unchanged: fail (the tampering signal)", async () => {
    await pinned();
    f.writeOp(f.bin, opStub("2.30.0", "tampered"));
    const [r] = await rows();
    assert.equal(r!.status, "fail");
    assert.match(r!.detail, /sha256 changed but the version is still 2\.30\.0/);
    assert.match(r!.suggestion!, /kit tools pin --accept op/);
  });

  it("version changed: warn, printing the new hash and the accept command", async () => {
    await pinned();
    f.writeOp(f.bin, opStub("2.31.0"));
    const m = await measureCli("op", f.deps);
    const [r] = await rows();
    assert.equal(r!.status, "warn");
    assert.match(r!.detail, /2\.30\.0 → 2\.31\.0/);
    assert.ok(r!.detail.includes(m!.sha256));
    assert.equal(r!.suggestion, "kit tools pin --accept op");
  });

  it("PATH shadow: an identical op earlier on PATH warns", async () => {
    await pinned();
    const shadow = join(f.proj, "shadow");
    f.writeOp(shadow, opStub("2.30.0"));
    f.deps.env = { PATH: `${shadow}:${f.bin}` };
    const [r] = await rows();
    assert.equal(r!.status, "warn");
    assert.match(r!.detail, /not the pinned .*PATH shadowing/);
  });
});
