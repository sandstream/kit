/**
 * Vendor-CLI pin at use time (kit-research#232): a pinned CLI that changed is refused before it
 * runs, with no fallback, and `--accept` re-enables it; each file is hashed once per process.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _hashReads,
  _resetHashCacheForTests,
  assertPinnedCli,
  execPinned,
  expandPath,
  portablePath,
  projectVendorClis,
  VendorCliPinRefusal,
} from "./vendor-cli-pin.js";
import { pinOne } from "./commands/tools-pin.js";
import {
  captureStderr,
  makeFixture,
  opStub,
  POSIX_ONLY,
  type Fixture,
} from "./vendor-cli-pin.test-support.js";

describe("vendor-CLI pin helpers", () => {
  it("stores a path under home as ~/… and expands it back", () => {
    const home = join(tmpdir(), "h");
    const real = join(home, ".local", "share", "mise", "op");
    assert.equal(portablePath(real, home), "~/.local/share/mise/op");
    assert.equal(expandPath("~/.local/share/mise/op", home), real);
    assert.equal(portablePath("/usr/bin/op", home), "/usr/bin/op");
  });

  it("derives the project's vendor CLIs from [secrets]", () => {
    const keys = { A: { source: "1password" }, B: { source: "gcp-sm" }, C: { source: "env" } };
    assert.deepEqual(projectVendorClis({ store: "1password", keys }), ["gcloud", "op"]);
  });
});

describe("vendor-CLI pin at use time", { skip: POSIX_ONLY }, () => {
  let f: Fixture;
  const read = () =>
    execPinned("op", ["read", "op://Dev/x/credential", "--no-newline"], { cwd: f.proj });

  beforeEach(async () => {
    f = makeFixture();
    assert.equal((await pinOne("op", false, f.deps, f.io)).result, "pinned");
    process.env.PATH = f.bin;
  });
  afterEach(() => f.done());

  it("a tampered op is refused before `op read` runs; accept re-enables it", async () => {
    f.writeOp(f.bin, opStub("2.30.0", "tampered"));
    f.clearLog();
    let thrown: unknown;
    const msg = await captureStderr(() => read().catch((e) => Promise.reject((thrown = e))));
    assert.ok(thrown instanceof VendorCliPinRefusal);
    assert.equal(f.logged(), "", "the refused binary was never executed, not even --version");
    assert.equal(process.exitCode, 1);
    assert.match(msg, /kit refused to run op: its SHA-256 differs from the pin/);
    assert.match(msg, /expected: .*sha256 [0-9a-f]{64}/);
    assert.match(msg, /actual: .*sha256 [0-9a-f]{64}/);
    assert.match(msg, /kit tools pin --accept op/);

    process.exitCode = 0;
    assert.equal((await pinOne("op", true, f.deps, f.io)).result, "accepted");
    assert.equal((await read()).stdout, "value");
    assert.match(f.logged(), /^read op:\/\/Dev\/x\/credential/m);
  });

  it("a shadowing op on PATH is refused, with no fallback to the pinned one", async () => {
    const shadow = join(f.proj, "shadow");
    f.writeOp(shadow, opStub("2.30.0"));
    process.env.PATH = `${shadow}:${f.bin}`;
    const msg = await captureStderr(() => assertPinnedCli("op", { ...f.deps, env: process.env }));
    assert.match(msg, /resolves to a different file/);
  });

  it("hashes each file once per process, not once per key", async () => {
    _resetHashCacheForTests();
    for (let i = 0; i < 5; i++) await assertPinnedCli("op", f.deps);
    assert.equal(_hashReads(), 1);
  });
});
