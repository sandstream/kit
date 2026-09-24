import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { openMemoryDb } from "./db.js";
import { fixture as cliFixture } from "./pal-cli.test-support.js";
import { seedLegacyPalDb } from "./pal-fixture.test-support.js";

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "kit-authority-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const files = await cliFixture(t, "", {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
  });
  // Restored historical bytes have no destination identity or approval files.
  seedLegacyPalDb(files.dbPath, [
    {
      id: "restored",
      title: "Restored artifact",
      kind: "auto",
      verify_check: JSON.stringify({ type: "file-exists", path: files.root }),
      origin_device: "source-device",
    },
  ]);
  openMemoryDb(files.dbPath).close();
  return { ...files, deviceFile: join(files.root, "store", "device-id") };
}

it("fresh local CLI configuration survives listing and subsequent verification", async (t) => {
  const { cli, root, deviceFile } = await fixture(t);
  assert.equal(existsSync(deviceFile), false);
  await cli("configure", "restored", "--verify-file", root);
  assert.equal(JSON.parse(await cli("verify", "--json")).checked, 1);
  await cli("list", "--all", "--global", "--json");
  assert.deepEqual(JSON.parse(await cli("verify", "--json")).closed, ["restored"]);
  assert.equal(existsSync(deviceFile), true);
});

it("CLI verification and manual disabling do not create a device identity", async (t) => {
  const { cli, deviceFile } = await fixture(t);
  const listing = ["list", "--all", "--global", "--read-only", "--json"];
  const before = JSON.parse(await cli(...listing));
  await assert.rejects(cli("verify", "--json"), (error: unknown) => {
    const failure = error as { code?: number; stdout?: string };
    assert.equal(failure.code, 1);
    const result = JSON.parse(failure.stdout ?? "");
    assert.equal(result.checked, 0);
    assert.equal(result.unverified[0]?.reason, "no-local-approval");
    return true;
  });
  assert.deepEqual(JSON.parse(await cli(...listing)), before);
  assert.equal(existsSync(deviceFile), false);
  await cli("configure", "restored", "--manual");
  assert.equal(existsSync(deviceFile), false);
});
