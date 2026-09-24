import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { deviceId, deviceIdOverrideActive, resolveDeviceIdentity } from "./device.js";
import { deviceId as palDeviceId, deviceIdOverrideActive as palOverrideActive } from "./pal.js";

function resolveInProcess(dir: string, override = ""): string {
  const source = import.meta.url.endsWith(".ts");
  return execFileSync(
    process.execPath,
    [
      ...(source ? ["--import", import.meta.resolve("tsx")] : []),
      "--input-type=module",
      "-e",
      "const { deviceId } = await import(process.argv[1]); process.stdout.write(deviceId());",
      new URL(source ? "./device.ts" : "./device.js", import.meta.url).href,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, KIT_MEMORY_DIR: dir, KIT_DEVICE_ID: override },
    },
  );
}

function isolatedDevice(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "kit-device-race-"));
  const previousDir = process.env.KIT_MEMORY_DIR;
  const previousOverride = process.env.KIT_DEVICE_ID;
  process.env.KIT_MEMORY_DIR = dir;
  delete process.env.KIT_DEVICE_ID;
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousDir === undefined) delete process.env.KIT_MEMORY_DIR;
    else process.env.KIT_MEMORY_DIR = previousDir;
    if (previousOverride === undefined) delete process.env.KIT_DEVICE_ID;
    else process.env.KIT_DEVICE_ID = previousOverride;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

it("retains PAL's public device helper exports", () => {
  assert.equal(palDeviceId, deviceId);
  assert.equal(palOverrideActive, deviceIdOverrideActive);
});

it("read-only resolution does not persist identity but still reads an existing one", (t) => {
  const dir = isolatedDevice(t);
  assert.equal(resolveDeviceIdentity({ persist: false }).source, "fallback");
  assert.equal(fs.existsSync(join(dir, "device-id")), false);
  const persisted = resolveDeviceIdentity();
  assert.deepEqual(resolveDeviceIdentity({ persist: false }), persisted);
});

it("reports whether identity is persisted, overridden, or degraded", (t) => {
  const dir = isolatedDevice(t);
  const persisted = resolveDeviceIdentity();
  assert.equal(persisted.source, "persisted");
  assert.equal(deviceId(), persisted.id);
  process.env.KIT_DEVICE_ID = "explicit-test-device";
  assert.deepEqual(resolveDeviceIdentity(), { id: "explicit-test-device", source: "override" });
  process.env.KIT_DEVICE_ID = "invalid override!";
  assert.deepEqual(resolveDeviceIdentity(), persisted);
  fs.writeFileSync(join(dir, "device-id"), "invalid persisted identity!");
  assert.equal(resolveDeviceIdentity().source, "fallback");
  assert.equal(resolveDeviceIdentity().id, deviceId());
});

it("separate processes recover the same persisted private device identity", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kit-device-"));
  try {
    const run = (override = "") => resolveInProcess(tmp, override);
    const original = run();
    assert.match(original, /^[a-f0-9]{16}$/);
    assert.equal(run(), original);
    assert.equal(run("malformed override!"), original);
    assert.equal(run("explicit-device"), "explicit-device");
    assert.equal(readFileSync(join(tmp, "device-id"), "utf8").trim(), original);
    // POSIX mode bits are not a Windows ACL check.
    if (process.platform !== "win32")
      assert.equal(statSync(join(tmp, "device-id")).mode & 0o777, 0o600);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

it("competing first callers retain the identity that another process already published", (t) => {
  const dir = isolatedDevice(t);
  const path = join(dir, "device-id");
  const originalExists = fs.existsSync;
  let competitor: string | undefined;
  // Pause after an absent-file observation so a real second process publishes first.
  t.mock.method(fs, "existsSync", (...args: Parameters<typeof fs.existsSync>) => {
    const exists = originalExists(...args);
    if (args[0] === path && !exists && competitor === undefined) {
      competitor = resolveInProcess(dir);
    }
    return exists;
  });
  syncBuiltinESMExports();

  const first = deviceId();
  assert.ok(competitor, "the competing process must actually run");
  assert.equal(first, competitor);
  assert.equal(resolveInProcess(dir), competitor);
});

it("another process never adopts a temporary identity from an unfinished first write", (t) => {
  const dir = isolatedDevice(t);
  const originalWrite = fs.writeFileSync;
  let competitor: string | undefined;
  // Split a real filesystem write at its empty-file window, before bytes are written.
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    const [file, data, options] = args;
    if (typeof file !== "string" || !file.startsWith(dir + sep) || competitor !== undefined) {
      return originalWrite(...args);
    }
    const opts = typeof options === "object" && options ? options : {};
    const fd = fs.openSync(file, opts.flag ?? "w", opts.mode);
    try {
      competitor = resolveInProcess(dir);
      originalWrite(fd, data, options);
    } finally {
      fs.closeSync(fd);
    }
  });
  syncBuiltinESMExports();

  const first = deviceId();
  assert.ok(competitor, "the competing process must actually run during the write");
  assert.equal(first, competitor);
  assert.equal(resolveInProcess(dir), competitor);
});

it("does not replace corrupt existing identity files with a new random origin", (t) => {
  const dir = isolatedDevice(t);
  const unavailable = join(dir, "not-a-directory");
  fs.writeFileSync(unavailable, "fixture\n");
  const fallback = resolveInProcess(unavailable);
  for (const content of ["", "partial!\n", "x".repeat(65)]) {
    fs.writeFileSync(join(dir, "device-id"), content);
    assert.equal(resolveInProcess(dir), fallback);
    assert.equal(readFileSync(join(dir, "device-id"), "utf8"), content);
  }
});

for (const failure of ["write", "publish"]) {
  it(`a failed ${failure} leaves no public partial identity or owned staging files`, (t) => {
    const dir = isolatedDevice(t);
    const unavailable = join(dir, "not-a-directory");
    fs.writeFileSync(unavailable, "fixture\n");
    const fallback = resolveInProcess(unavailable);
    const originalWrite = fs.writeFileSync;
    if (failure === "write") {
      t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
        originalWrite(args[0], "", args[2]);
        throw Object.assign(new Error("interrupted write"), { code: "EIO" });
      });
    } else {
      t.mock.method(fs, "linkSync", () => {
        throw Object.assign(new Error("publication unavailable"), { code: "EPERM" });
      });
    }
    syncBuiltinESMExports();
    assert.equal(deviceId(), fallback);
    assert.deepEqual(fs.readdirSync(dir), ["not-a-directory"]);
  });
}

it("staging cleanup failure does not change an already published identity", (t) => {
  const dir = isolatedDevice(t);
  t.mock.method(fs, "rmSync", () => {
    throw Object.assign(new Error("cleanup unavailable"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  const published = deviceId();
  assert.match(published, /^[a-f0-9]{16}$/);
  assert.equal(resolveInProcess(dir), published);
  assert.equal(readFileSync(join(dir, "device-id"), "utf8").trim(), published);
});

it("an abandoned staging directory neither becomes identity nor blocks a fresh startup", (t) => {
  const dir = isolatedDevice(t);
  const abandoned = join(dir, ".device-id-abandoned");
  fs.mkdirSync(abandoned);
  fs.writeFileSync(join(abandoned, "id"), "abandoned-origin\n");
  const published = deviceId();
  assert.match(published, /^[a-f0-9]{16}$/);
  assert.equal(resolveInProcess(dir), published);
  assert.deepEqual(fs.readdirSync(dir).sort(), [".device-id-abandoned", "device-id"]);
  assert.equal(readFileSync(join(abandoned, "id"), "utf8"), "abandoned-origin\n");
});
