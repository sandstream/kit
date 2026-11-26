/**
 * The vendor-CLI identity pin (kit-research#232): record, check, accept, and refuse at use time.
 *
 * Every binary here is a fake `op`: a POSIX shell stub that logs its argv and prints the version
 * written into its own bytes, so editing the version also changes the hash, and editing a comment
 * changes the hash alone. The stubs need `/bin/sh`, so the tests that run them skip on win32; the
 * PATH/PATHEXT lookup and the pure judgements run everywhere.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { findOnPath, pathCandidates } from "./utils/path-lookup.js";
import {
  _hashReads,
  _resetHashCacheForTests,
  assertPinnedCli,
  execPinned,
  measureCli,
  portablePath,
  expandPath,
  projectVendorClis,
  readPin,
  VendorCliPinRefusal,
  type PinDeps,
} from "./vendor-cli-pin.js";
import { checkVendorCliPins } from "./check-vendor-cli-pin.js";
import { pinOne, type PinIo } from "./commands/tools-pin.js";

const POSIX_ONLY = process.platform === "win32" ? "fake CLIs are /bin/sh scripts" : false;

describe("PATH lookup (pure, every platform)", () => {
  it("POSIX: PATH order, and a relative `.` entry resolves against cwd (the ./op shadow)", () => {
    const c = pathCandidates("op", { PATH: ".:/usr/local/bin:/usr/bin" }, "linux", "/proj");
    assert.deepEqual(c, ["/proj/op", "/usr/local/bin/op", "/usr/bin/op"]);
    const hit = findOnPath("op", { PATH: "/a:/b" }, "linux", "/proj", (p) => p === "/b/op");
    assert.equal(hit, posix.join("/b", "op"));
  });

  it("win32: current directory first, then PATH, each with every PATHEXT extension", () => {
    const env = { Path: "C:\\tools;C:\\bin", PATHEXT: ".EXE;.CMD" };
    const c = pathCandidates("op", env, "win32", "C:\\proj");
    assert.deepEqual(c, [
      "C:\\proj\\op.exe",
      "C:\\proj\\op.cmd",
      "C:\\tools\\op.exe",
      "C:\\tools\\op.cmd",
      "C:\\bin\\op.exe",
      "C:\\bin\\op.cmd",
    ]);
    const hit = findOnPath("op", env, "win32", "C:\\proj", (p) => p === "C:\\bin\\op.cmd");
    assert.equal(hit, win32.join("C:\\bin", "op.cmd"));
    // A name that already carries an extension is not extended again.
    assert.deepEqual(pathCandidates("op.exe", { Path: "C:\\t" }, "win32", "C:\\p"), [
      "C:\\p\\op.exe",
      "C:\\t\\op.exe",
    ]);
  });

  it("stores a path under home as ~/… and expands it back", () => {
    const home = join(tmpdir(), "h");
    const real = join(home, ".local", "share", "mise", "op");
    assert.equal(portablePath(real, home), "~/.local/share/mise/op");
    assert.equal(expandPath("~/.local/share/mise/op", home), real);
    assert.equal(portablePath("/usr/bin/op", home), "/usr/bin/op");
  });

  it("derives the project's vendor CLIs from [secrets]", () => {
    const tools = projectVendorClis({
      store: "1password",
      keys: { A: { source: "1password" }, B: { source: "gcp-sm" }, C: { source: "env" } },
    });
    assert.deepEqual(tools, ["gcloud", "op"]);
  });
});

function stub(version: string, note = ""): string {
  return `#!/bin/sh
# fake op ${note}
printf '%s\\n' "$*" >> "$OP_LOG"
case "$1" in
  --version) printf '%s\\n' "${version}" ;;
  read) printf 'value' ;;
esac
`;
}

describe("vendor-CLI pin with a fake op", { skip: POSIX_ONLY }, () => {
  let root: string;
  let proj: string;
  let bin: string;
  let log: string;
  let deps: PinDeps;
  let audits: Array<Record<string, unknown>>;
  let io: PinIo;
  const savedPath = process.env.PATH;
  const savedLog = process.env.OP_LOG;

  const writeOp = (dir: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "op"), body);
    chmodSync(join(dir, "op"), 0o755);
  };
  const logged = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const rows = () => checkVendorCliPins(proj, { store: "1password" }, deps);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kit-vcp-"));
    proj = join(root, "proj");
    bin = join(root, "bin");
    mkdirSync(proj);
    writeOp(bin, stub("2.30.0"));
    log = join(root, "op.log");
    process.env.OP_LOG = log;
    deps = {
      cwd: proj,
      env: { PATH: bin },
      platform: process.platform,
      arch: process.arch,
      home: join(root, "home"),
      miseWhich: async () => null,
    };
    audits = [];
    io = {
      audit: async (e) => (audits.push(e), true),
      versionOf: async (b) => {
        const { readCliVersion } = await import("./vendor-cli-pin.js");
        return readCliVersion(b);
      },
    };
    _resetHashCacheForTests();
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.OP_LOG;
    else process.env.OP_LOG = savedLog;
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  it("nothing pinned: warn with the exact pin command; no vendor CLI at all: skip", async () => {
    const [r] = await rows();
    assert.equal(r!.status, "warn");
    assert.match(r!.detail, /unpinned: kit runs whatever op is first on PATH/);
    assert.equal(r!.suggestion, "kit tools pin op");
    const none = await checkVendorCliPins(proj, { store: "env" }, deps);
    assert.equal(none.length, 1);
    assert.equal(none[0]!.status, "skip");
  });

  it("pin then check: unchanged passes with the pinned version, and runs nothing", async () => {
    const o = await pinOne("op", false, deps, io);
    assert.equal(o.result, "pinned");
    const lock = JSON.parse(readFileSync(join(proj, ".kit", "cli-lock.json"), "utf8"));
    const id = Object.values(lock.identity.op)[0] as { sha256: string; version: string };
    assert.match(id.sha256, /^[0-9a-f]{64}$/);
    assert.equal(id.version, "2.30.0");
    writeFileSync(log, "");
    const [r] = await rows();
    assert.equal(r!.status, "pass");
    assert.match(r!.detail, /op 2\.30\.0 matches its pin/);
    assert.equal(logged(), "", "an unchanged binary is hashed, never executed");
  });

  it("hash changed, version unchanged: fail (the tampering signal)", async () => {
    await pinOne("op", false, deps, io);
    writeOp(bin, stub("2.30.0", "tampered"));
    const [r] = await rows();
    assert.equal(r!.status, "fail");
    assert.match(r!.detail, /sha256 changed but the version is still 2\.30\.0/);
    assert.match(r!.suggestion!, /kit tools pin --accept op/);
  });

  it("version changed: warn, printing the new hash and the accept command", async () => {
    await pinOne("op", false, deps, io);
    writeOp(bin, stub("2.31.0"));
    const m = await measureCli("op", deps);
    const [r] = await rows();
    assert.equal(r!.status, "warn");
    assert.match(r!.detail, /2\.30\.0 → 2\.31\.0/);
    assert.ok(r!.detail.includes(m!.sha256));
    assert.equal(r!.suggestion, "kit tools pin --accept op");
  });

  it("PATH shadow: an identical op earlier on PATH warns", async () => {
    await pinOne("op", false, deps, io);
    const shadow = join(proj, "shadow");
    writeOp(shadow, stub("2.30.0"));
    deps.env = { PATH: `${shadow}:${bin}` };
    const [r] = await rows();
    assert.equal(r!.status, "warn");
    assert.match(r!.detail, /not the pinned .*PATH shadowing/);
  });

  it("a symlinked op (Homebrew-style) is pinned by its realpath target", async () => {
    const cellar = join(root, "Cellar", "op", "2.30.0", "bin");
    writeOp(cellar, stub("2.30.0"));
    const link = join(root, "linkbin");
    mkdirSync(link);
    symlinkSync(join(cellar, "op"), join(link, "op"));
    deps.env = { PATH: link };
    const o = await pinOne("op", false, deps, io);
    assert.equal(o.identity!.path.endsWith(join("Cellar", "op", "2.30.0", "bin", "op")), true);
  });

  it("accept is explicit and audited: plain pin refuses a change, --accept writes an audit row", async () => {
    await pinOne("op", false, deps, io);
    writeOp(bin, stub("2.31.0"));
    const refused = await pinOne("op", false, deps, io);
    assert.equal(refused.result, "refused");
    assert.match(refused.detail, /kit tools pin --accept op/);
    const accepted = await pinOne("op", true, deps, io);
    assert.equal(accepted.result, "accepted");
    const last = audits.at(-1)!;
    assert.equal(last.operation, "vendor-cli-pin-accept");
    const meta = last.metadata as { previous: { version: string }; accepted: { version: string } };
    assert.equal(meta.previous.version, "2.30.0");
    assert.equal(meta.accepted.version, "2.31.0");
    assert.equal((await readPin("op", deps))!.version, "2.31.0");
  });

  it("no pin is written when the audit row cannot be", async () => {
    io.audit = async () => false;
    const o = await pinOne("op", false, deps, io);
    assert.equal(o.result, "error");
    assert.equal(await readPin("op", deps), null);
  });

  it("the real audit log gets the accept row", async () => {
    const { appendAuditEventDirect } = await import("./audit.js");
    io.audit = (e) => appendAuditEventDirect(e, { cwd: proj });
    await pinOne("op", false, deps, io);
    writeOp(bin, stub("2.31.0"));
    await pinOne("op", true, deps, io);
    const lines = readFileSync(join(proj, ".kit-audit.jsonl"), "utf8").trim().split("\n");
    const ops = lines.map((l) => JSON.parse(l).operation);
    assert.deepEqual(ops.slice(-2), ["vendor-cli-pin", "vendor-cli-pin-accept"]);
  });

  it("use time: a tampered op is refused before `op read` runs, then accept re-enables it", async () => {
    await pinOne("op", false, deps, io);
    writeOp(bin, stub("2.30.0", "tampered"));
    process.env.PATH = bin;
    writeFileSync(log, "");
    const errs: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (
      errs.push(String(s)),
      true
    )) as typeof process.stderr.write;
    let thrown: unknown;
    try {
      await execPinned("op", ["read", "op://Dev/x/credential", "--no-newline"], { cwd: proj });
    } catch (e) {
      thrown = e;
    } finally {
      process.stderr.write = write;
    }
    assert.ok(thrown instanceof VendorCliPinRefusal);
    assert.equal(logged(), "", "the refused binary was never executed, not even --version");
    assert.equal(process.exitCode, 1);
    const msg = errs.join("");
    assert.match(msg, /kit refused to run op: its SHA-256 differs from the pin/);
    assert.match(msg, /expected: .*sha256 [0-9a-f]{64}/);
    assert.match(msg, /actual: .*sha256 [0-9a-f]{64}/);
    assert.match(msg, /kit tools pin --accept op/);
    process.exitCode = 0;

    assert.equal((await pinOne("op", true, deps, io)).result, "accepted");
    const out = await execPinned("op", ["read", "op://Dev/x/credential", "--no-newline"], {
      cwd: proj,
    });
    assert.equal(out.stdout, "value");
    assert.match(logged(), /^read op:\/\/Dev\/x\/credential/m);
  });

  it("use time: a shadowing op on PATH is refused, with no fallback to the pinned one", async () => {
    await pinOne("op", false, deps, io);
    const shadow = join(proj, "shadow");
    writeOp(shadow, stub("2.30.0"));
    process.env.PATH = `${shadow}:${bin}`;
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await assert.rejects(
        assertPinnedCli("op", { ...deps, env: process.env }),
        /resolves to a different file/,
      );
    } finally {
      process.stderr.write = write;
    }
  });

  it("hashes each file once per process, not once per key", async () => {
    await pinOne("op", false, deps, io);
    _resetHashCacheForTests();
    for (let i = 0; i < 5; i++) await assertPinnedCli("op", deps);
    assert.equal(_hashReads(), 1);
  });
});
