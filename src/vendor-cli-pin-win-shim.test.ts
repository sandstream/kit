/**
 * The vendor-CLI pin through a win32 npm `.cmd` shim: kit pins the JS entry the shim starts and
 * the shim itself, refuses a tampered entry or an edited shim, and refuses a shim it cannot read
 * instead of reaching for a shell.
 *
 * The pin tests run on every OS: `PinDeps.platform` is `"win32"` and the fake tree is plain files
 * (no chmod, no /bin/sh), so the win32 branch is exercised on Linux and macOS too. The end-to-end
 * test starts a real process through a fake shim and only means something on Windows, where Node
 * refuses to `execFile` a `.cmd`; it skips elsewhere and Windows CI runs it.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetHashCacheForTests,
  assertPinnedCli,
  execPinned,
  measureCli,
  readPin,
  resolvePinnedLaunch,
  VendorCliPinRefusal,
  type PinDeps,
} from "./vendor-cli-pin.js";
import { pinOne, type PinIo } from "./commands/tools-pin.js";
import { checkVendorCliPins } from "./check-vendor-cli-pin.js";

const WIN_ONLY =
  process.platform === "win32"
    ? false
    : "Node starts a .cmd without a shell only on Windows (EINVAL there); Windows CI runs this";

/** npm 7+ `cmd-shim` output for `vercel` installed globally into `dir`. */
function npmShim(entryRel: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entryRel}" %*`,
    "",
  ].join("\r\n");
}

const ENTRY = "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n// v1\n";

interface Tree {
  root: string;
  proj: string;
  shimDir: string;
  shim: string;
  entry: string;
  deps: PinDeps;
  io: PinIo;
}

/** `<root>/npm dir/vercel.cmd` → `node_modules\vercel cli\bin\vc.js` (spaces on purpose). */
function makeTree(platform: NodeJS.Platform = "win32"): Tree {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kit-winshim-")));
  const proj = join(root, "proj");
  const shimDir = join(root, "npm dir");
  const entryDir = join(shimDir, "node_modules", "vercel cli", "bin");
  mkdirSync(proj);
  mkdirSync(entryDir, { recursive: true });
  const shim = join(shimDir, "vercel.cmd");
  const entry = join(entryDir, "vc.js");
  writeFileSync(shim, npmShim("node_modules\\vercel cli\\bin\\vc.js"));
  writeFileSync(entry, ENTRY);
  _resetHashCacheForTests();
  return {
    root,
    proj,
    shimDir,
    shim,
    entry,
    deps: {
      cwd: proj,
      env: { PATH: shimDir },
      platform,
      arch: "x64",
      home: join(root, "home"),
      miseWhich: async () => shim,
    },
    io: { audit: async () => true, versionOf: async () => "41.0.0" },
  };
}

async function refusal(p: Promise<unknown>): Promise<VendorCliPinRefusal> {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof VendorCliPinRefusal, String(err));
    return err;
  } finally {
    process.stderr.write = write;
    process.exitCode = 0;
  }
  assert.fail("expected a VendorCliPinRefusal");
}

describe("vendor-CLI pin through a win32 npm shim", () => {
  let t: Tree;
  beforeEach(() => (t = makeTree()));
  afterEach(() => {
    process.exitCode = 0;
    rmSync(t.root, { recursive: true, force: true });
  });

  it("measures the JS entry, runs it with kit's own node, and hashes the shim", async () => {
    const m = (await measureCli("vercel", t.deps))!;
    assert.equal(m.realpath, t.entry);
    assert.equal(m.shim?.path, t.shim);
    assert.deepEqual(m.launch, { file: process.execPath, prefix: [t.entry] });
  });

  it("pins the entry and records that it came via the shim", async () => {
    const seen: unknown[] = [];
    const io: PinIo = { ...t.io, versionOf: async (l) => (seen.push(l), "41.0.0") };
    const o = await pinOne("vercel", false, t.deps, io);
    assert.equal(o.result, "pinned", o.detail);
    const pin = (await readPin("vercel", t.deps))!;
    assert.equal(pin.path, t.entry);
    assert.equal(pin.shim?.path, t.shim);
    assert.match(o.detail, /via shim/);
    // `--version` ran through node + entry, never the .cmd.
    assert.deepEqual(seen, [{ file: process.execPath, prefix: [t.entry] }]);
    assert.equal(await assertPinnedCli("vercel", t.deps), t.entry);
    const l = await resolvePinnedLaunch("vercel", t.proj, t.deps);
    assert.deepEqual(l, { file: process.execPath, prefix: [t.entry] });
  });

  it("refuses a tampered entry", async () => {
    await pinOne("vercel", false, t.deps, t.io);
    writeFileSync(t.entry, ENTRY.replace("v1", "evil"));
    const err = await refusal(resolvePinnedLaunch("vercel", t.proj, t.deps));
    assert.match(err.message, /SHA-256 differs/);
    const rows = await checkVendorCliPins(t.proj, undefined, t.deps, async () => "41.0.0");
    assert.equal(rows[0]!.status, "fail");
  });

  it("refuses a shim edited to start something else, even with the old entry intact", async () => {
    await pinOne("vercel", false, t.deps, t.io);
    const other = join(t.shimDir, "node_modules", "vercel cli", "bin", "other.js");
    writeFileSync(other, ENTRY);
    writeFileSync(t.shim, npmShim("node_modules\\vercel cli\\bin\\other.js"));
    const err = await refusal(resolvePinnedLaunch("vercel", t.proj, t.deps));
    assert.match(err.message, /different file|shim/);
  });

  it("refuses a shim whose text changed but still names the pinned entry", async () => {
    await pinOne("vercel", false, t.deps, t.io);
    writeFileSync(
      t.shim,
      "@SET NODE_OPTIONS=--require=C:\\evil.js\r\n" +
        npmShim("node_modules\\vercel cli\\bin\\vc.js"),
    );
    const err = await refusal(resolvePinnedLaunch("vercel", t.proj, t.deps));
    assert.match(err.message, /\.cmd shim differs/);
    const rows = await checkVendorCliPins(t.proj, undefined, t.deps, async () => "41.0.0");
    assert.equal(rows[0]!.status, "fail");
    assert.match(rows[0]!.detail, /shim changed/);
    const o = await pinOne("vercel", false, t.deps, t.io);
    assert.equal(o.result, "refused");
  });

  it("refuses an unparseable shim: never pinned, never run, no shell", async () => {
    const fresh = await pinOne("vercel", false, { ...t.deps, cwd: t.root }, t.io);
    assert.equal(fresh.result, "pinned", "a readable shim pins (into another project)");
    writeFileSync(t.shim, '@ECHO off\r\npowershell -File "%~dp0\\vercel.ps1" %*\r\n');
    const o = await pinOne("vercel", false, t.deps, t.io);
    assert.equal(o.result, "error");
    assert.match(o.detail, /could not read.*will not fall back to one/s);
    const err = await refusal(resolvePinnedLaunch("vercel", t.proj, t.deps));
    assert.match(err.message, /batch shim kit could not read/);
    const deps = { ...t.deps, cwd: t.root };
    const rows = await checkVendorCliPins(t.root, undefined, deps);
    assert.equal(rows[0]!.status, "fail");
    assert.match(rows[0]!.detail, /could not read/);
    await refusal(resolvePinnedLaunch("vercel", t.root, deps));
  });

  it("refuses a shim that names a file that does not exist", async () => {
    writeFileSync(t.shim, npmShim("node_modules\\gone\\x.js"));
    const err = await refusal(resolvePinnedLaunch("vercel", t.proj, t.deps));
    assert.match(err.message, /does not exist/);
  });

  it("leaves POSIX alone: a .cmd there is just the file, run as itself", async () => {
    const posix = makeTree("linux");
    try {
      const m = (await measureCli("vercel", posix.deps))!;
      assert.equal(m.realpath, posix.shim);
      assert.equal(m.shim, undefined);
      assert.deepEqual(m.launch, { file: posix.shim, prefix: [] });
    } finally {
      rmSync(posix.root, { recursive: true, force: true });
    }
  });
});

describe("win32 npm shim, end to end", () => {
  it(
    "starts a CLI through its .cmd shim with no shell, arguments intact",
    { skip: WIN_ONLY },
    async () => {
      const t = makeTree(process.platform);
      const saved = process.env.PATH;
      try {
        process.env.PATH = `${t.shimDir};${saved ?? ""}`;
        // Metacharacters a shell would act on reach the program as plain text.
        const args = ["a&b", "x|y", '"q"', "100%", "sp ace"];
        const { stdout } = await execPinned("vercel", args, { cwd: t.proj, timeout: 30_000 });
        assert.deepEqual(JSON.parse(stdout), args);
        const deps = { ...t.deps, env: process.env, miseWhich: async () => null };
        assert.equal((await pinOne("vercel", false, deps, t.io)).result, "pinned");
        const again = await execPinned("vercel", ["ok"], { cwd: t.proj, timeout: 30_000 });
        assert.deepEqual(JSON.parse(again.stdout), ["ok"]);
        writeFileSync(t.entry, ENTRY.replace("v1", "evil"));
        await refusal(execPinned("vercel", ["no"], { cwd: t.proj, timeout: 30_000 }));
      } finally {
        process.env.PATH = saved;
        process.exitCode = 0;
        rmSync(t.root, { recursive: true, force: true });
      }
    },
  );
});
