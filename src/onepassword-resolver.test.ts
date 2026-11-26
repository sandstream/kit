/**
 * One resolver for every 1Password call. `op whoami`, the status probe, `op account list`,
 * `op read` (backends, checkSecrets, vault migration) and `op item get` (expiry) all resolve `op`
 * the way the vendor-CLI pin measures it, mise first, then PATH. A different `op` earlier on PATH
 * than the mise one is never started, pinned or not, so the identity check covers every call.
 * Fake CLIs only: a `mise` stub that answers `mise which op`, and two `op` stubs.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinOne } from "./commands/tools-pin.js";
import { check1PasswordStatus, detect1PasswordMode } from "./onepassword.js";
import { checkSecrets } from "./check-secrets.js";
import { resolveViaBackend } from "./secret-backends.js";
import { get1PasswordExpiration } from "./secret-expiration.js";
import { readSecretFromBackend } from "./secrets-vault-migrate.js";
import { makeFixture, opStub, POSIX_ONLY, type Fixture } from "./vendor-cli-pin.test-support.js";

describe("1Password: every call resolves the same op", { skip: POSIX_ONLY }, () => {
  let f: Fixture;
  let miseOp: string;
  let pathLog: string;
  const savedToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  const cwd = process.cwd();
  const REF = "op://Dev/item/f";

  beforeEach(() => {
    f = makeFixture();
    const miseDir = join(f.root, "mise-installs", "op");
    f.writeOp(miseDir, opStub("2.30.0", "mise"));
    miseOp = join(miseDir, "op");
    // A different op, first on PATH: it must never be started.
    pathLog = join(f.root, "path-op.log");
    writeFileSync(join(f.bin, "op"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${pathLog}"\n`);
    const mise = join(f.bin, "mise");
    writeFileSync(mise, `#!/bin/sh\n[ "$1" = which ] && [ "$2" = op ] && echo "${miseOp}"\n`);
    chmodSync(mise, 0o755);
    process.env.PATH = f.bin;
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    process.chdir(f.proj);
  });

  afterEach(() => {
    process.chdir(cwd);
    if (savedToken !== undefined) process.env.OP_SERVICE_ACCOUNT_TOKEN = savedToken;
    f.done();
  });

  async function everyOpCall(): Promise<void> {
    await check1PasswordStatus();
    await detect1PasswordMode();
    await resolveViaBackend("K", { source: "1password", ref: REF });
    await checkSecrets(
      { store: "1password", keys: { K: { source: "1password", ref: REF } } },
      f.proj,
    );
    await get1PasswordExpiration(REF);
    await readSecretFromBackend("1password", { source: "1password", ref: REF }, {});
  }

  function assertOnlyMiseOpRan(): void {
    assert.equal(existsSync(pathLog) ? readFileSync(pathLog, "utf8") : "", "", "PATH op ran");
    const ran = f.logged();
    for (const line of [/^--version$/m, /^whoami$/m, /^account list/m, /^read /m, /^item get /m])
      assert.match(ran, line);
  }

  it("unpinned: whoami, the status probe and op read all run the mise-resolved op", async () => {
    await everyOpCall();
    assertOnlyMiseOpRan();
    assert.notEqual(process.exitCode, 1);
  });

  it("pinned to the mise op: no call is refused as moved, so none resolves the PATH op", async () => {
    const deps = { ...f.deps, env: process.env, miseWhich: async () => miseOp };
    assert.equal((await pinOne("op", false, deps, f.io)).result, "pinned");
    f.clearLog();
    await everyOpCall();
    assertOnlyMiseOpRan();
    assert.notEqual(process.exitCode, 1, "a call resolved a different op than the pin");
  });
});
