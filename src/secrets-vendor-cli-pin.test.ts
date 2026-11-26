/**
 * Use-time enforcement of the vendor-CLI pin on the secret read paths (kit-research#232):
 * `checkSecrets`, the backends' `resolveViaBackend` and the 1Password expiry probe must refuse a
 * pinned CLI that changed, without running it, and run it again once `--accept` re-trusted it.
 *
 * Fake CLIs only: POSIX shell stubs that log argv. They need `/bin/sh`, so the suite skips on win32.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetHashCacheForTests, readCliVersion, type PinDeps } from "./vendor-cli-pin.js";
import { pinOne, type PinIo } from "./commands/tools-pin.js";
import { checkSecrets } from "./check-secrets.js";
import { resolveViaBackend } from "./secret-backends.js";
import { get1PasswordExpiration } from "./secret-expiration.js";

const POSIX_ONLY = process.platform === "win32" ? "fake CLIs are /bin/sh scripts" : false;

function stub(tool: string, note: string): string {
  return `#!/bin/sh
# fake ${tool} ${note}
printf '%s %s\\n' "${tool}" "$*" >> "$STUB_LOG"
case "$1" in
  --version) printf '1.0.0\\n' ;;
  whoami) printf 'me\\n' ;;
  item) printf '{"id":"x"}' ;;
  *) printf 'value' ;;
esac
`;
}

describe("vendor-CLI pin at use time on the secret paths", { skip: POSIX_ONLY }, () => {
  let root: string;
  let proj: string;
  let bin: string;
  let log: string;
  let deps: PinDeps;
  const io: PinIo = { audit: async () => true, versionOf: readCliVersion };
  const saved = { path: process.env.PATH, log: process.env.STUB_LOG, cwd: process.cwd() };
  let restoreStderr: () => void;

  const write = (tool: string, note: string) => {
    writeFileSync(join(bin, tool), stub(tool, note));
    chmodSync(join(bin, tool), 0o755);
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "kit-vcp-use-"));
    proj = join(root, "proj");
    bin = join(root, "bin");
    mkdirSync(proj);
    mkdirSync(bin);
    log = join(root, "calls.log");
    for (const t of ["op", "doppler"]) write(t, "original");
    process.env.PATH = bin;
    process.env.STUB_LOG = log;
    process.chdir(proj);
    deps = {
      cwd: proj,
      env: { PATH: bin },
      platform: process.platform,
      arch: process.arch,
      home: join(root, "home"),
      miseWhich: async () => null,
    };
    _resetHashCacheForTests();
    for (const t of ["op", "doppler"])
      assert.equal((await pinOne(t, false, deps, io)).result, "pinned");
    for (const t of ["op", "doppler"]) write(t, "tampered");
    writeFileSync(log, "");
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    restoreStderr = () => (process.stderr.write = original);
  });

  afterEach(() => {
    restoreStderr();
    process.chdir(saved.cwd);
    process.env.PATH = saved.path;
    if (saved.log === undefined) delete process.env.STUB_LOG;
    else process.env.STUB_LOG = saved.log;
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it("checkSecrets: a tampered doppler is never run, and the process exits non-zero", async () => {
    const r = await checkSecrets({ keys: { K: { source: "doppler", name: "K" } } }, proj);
    assert.equal(r.keys[0]!.available, false);
    assert.equal(calls(), "");
    assert.equal(process.exitCode, 1);
  });

  it("resolveViaBackend: refused before `doppler secrets get`; accept re-enables it", async () => {
    const before = await resolveViaBackend("K", { source: "doppler", name: "K" });
    assert.equal(before.resolved, false);
    assert.equal(calls(), "");
    process.exitCode = 0;
    assert.equal((await pinOne("doppler", true, deps, io)).result, "accepted");
    const after = await resolveViaBackend("K", { source: "doppler", name: "K" });
    assert.equal(after.value, "value");
    assert.match(calls(), /^doppler secrets get K --plain$/m);
  });

  it("checkSecrets for 1Password: neither the status probe nor `op read` runs a tampered op", async () => {
    const r = await checkSecrets(
      { store: "1password", keys: { K: { source: "1password", ref: "op://Dev/item/f" } } },
      proj,
    );
    assert.equal(r.keys[0]!.available, false);
    assert.equal(calls(), "");
  });

  it("the 1Password expiry probe does not run `op item get` on a tampered op", async () => {
    assert.equal(await get1PasswordExpiration("op://Dev/item/f"), null);
    assert.equal(calls(), "");
    assert.equal(process.exitCode, 1);
  });
});
