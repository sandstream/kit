/**
 * kit-research verify-against-real-state-vs-kit: a gate command that pointed at any executable
 * exiting 0 passed `enforcement gate liveness` and `enforcement evidence`. The wired command is now
 * resolved to the kit entrypoint it would start, by reading files only, and a gate that is not kit
 * fails the evidence row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gateIdentityFacts, identifyGate } from "./gate-identity.js";
import { judgeEvidence, type EvidenceFacts } from "./check-enforcement-evidence.js";
import { WRAPPER_MARKER } from "./kit-wrapper.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

function sandbox(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-gate-id-"));
  t.after(() => rmTemp(dir));
  return dir;
}

/** A package with a dist/cli.js; `name` decides whether it is kit. */
function fakePackage(dir: string, name: string, version = "9.9.9"): string {
  const pkg = join(dir, "pkg-" + name);
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
  const cli = join(pkg, "dist", "cli.js");
  writeFileSync(cli, "// cli\n");
  return cli;
}

function exe(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

const q = (p: string) => JSON.stringify(p);

describe("identifyGate", () => {
  it("node with kit's cli.js is kit, with its version", (t) => {
    const dir = sandbox(t);
    const cli = fakePackage(dir, "sandstream-kit", "7.5.0");
    const id = identifyGate(`${q(process.execPath)} ${q(cli)} gate-bash`);
    assert.equal(id.kit, true);
    if (id.kit) assert.equal(id.version, "7.5.0");
  });

  it("a kit-managed POSIX wrapper resolves through its exec line", (t) => {
    const dir = sandbox(t);
    const cli = fakePackage(dir, "sandstream-kit");
    const w = exe(
      join(dir, "kit"),
      `#!/bin/sh\n${WRAPPER_MARKER}\nexec "${process.execPath}" "${cli}" "$@"\n`,
    );
    assert.equal(identifyGate(`${q(w)} gate-env`).kit, true);
  });

  it("a kit-managed .cmd wrapper resolves through its run line", (t) => {
    const dir = sandbox(t);
    const cli = fakePackage(dir, "sandstream-kit");
    const w = exe(
      join(dir, "kit.cmd"),
      `@echo off\r\nrem ${WRAPPER_MARKER}\r\n"${process.execPath}" "${cli}" %*\r\n`,
    );
    assert.equal(identifyGate(`${q(w)} gate-bash`).kit, true);
  });

  it("a stub that exits 0 is not kit", (t) => {
    const dir = sandbox(t);
    const stub = exe(join(dir, "kit"), "#!/bin/sh\ncat >/dev/null\nexit 0\n");
    const id = identifyGate(`${q(stub)} gate-bash`);
    assert.equal(id.kit, false);
    if (!id.kit) assert.match(id.why, /not node, a kit-managed wrapper/);
  });

  it("a wrapper that only carries the marker but runs another package is not kit", (t) => {
    const dir = sandbox(t);
    const other = fakePackage(dir, "not-kit");
    const w = exe(
      join(dir, "kit"),
      `#!/bin/sh\n${WRAPPER_MARKER}\nexec "${process.execPath}" "${other}" "$@"\n`,
    );
    const id = identifyGate(`${q(w)} gate-bash`);
    assert.equal(id.kit, false);
    if (!id.kit) assert.match(id.why, /not in the sandstream-kit package/);
  });

  it("a link to kit's cli.js is kit", (t) => {
    if (process.platform === "win32") {
      t.skip("symlinks need privileges on Windows; npm uses .cmd shims there");
      return;
    }
    const dir = sandbox(t);
    const cli = fakePackage(dir, "sandstream-kit");
    const link = join(dir, "kit-link");
    symlinkSync(cli, link);
    assert.equal(identifyGate(`${q(link)} gate-bash`).kit, true);
  });
});

describe("gateIdentityFacts", () => {
  function settings(root: string, commands: string[]) {
    mkdirSync(join(root, ".claude"), { recursive: true });
    const hooks = commands.map((command) => ({
      matcher: "*",
      hooks: [{ type: "command", command }],
    }));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: hooks } }),
    );
  }

  it("names a wired gate that is not kit", (t) => {
    const dir = sandbox(t);
    const stub = exe(join(dir, "stub"), "#!/bin/sh\nexit 0\n");
    settings(dir, [`${q(stub)} gate-bash`, `${q(stub)} gate-env`]);
    const f = gateIdentityFacts(dir, "7.5.0", join(dir, "home"));
    assert.equal(f.notKit.length, 2);
  });

  it("reports a kit of another version, and nothing for the running one", (t) => {
    const dir = sandbox(t);
    const old = fakePackage(dir, "sandstream-kit", "7.0.0");
    settings(dir, [`${q(process.execPath)} ${q(old)} gate-bash`]);
    assert.deepEqual(gateIdentityFacts(dir, "7.5.0", join(dir, "home")).otherVersions, ["7.0.0"]);
    assert.deepEqual(gateIdentityFacts(dir, "7.0.0", join(dir, "home")), {
      notKit: [],
      otherVersions: [],
    });
  });
});

describe("judgeEvidence with gate identity", () => {
  const wired = { installGate: true, envGate: true, everInstalled: true, problems: [] as string[] };
  const facts = (identity: EvidenceFacts["identity"]): EvidenceFacts => ({
    liveness: wired,
    proof: { total: 6, failed: [], inconclusive: [], notRun: [] },
    bypass: { entries: [] },
    now: Date.parse("2026-11-20T00:00:00Z"),
    identity,
  });

  it("fails when a wired gate is not kit, even though the controls held", () => {
    const r = judgeEvidence(
      facts({ notKit: [{ target: "/x/kit", why: "stub" }], otherVersions: [] }),
    );
    assert.equal(r.status, "fail");
    assert.match(r.detail, /do not run kit: \/x\/kit/);
  });

  it("warns when the gates run another kit version", () => {
    const r = judgeEvidence(facts({ notKit: [], otherVersions: ["7.0.0"] }));
    assert.equal(r.status, "warn");
    assert.match(r.detail, /run kit 7\.0\.0/);
  });

  it("passes and says the gates resolve to this kit when they do", () => {
    const r = judgeEvidence(facts({ notKit: [], otherVersions: [] }));
    assert.equal(r.status, "pass");
    assert.match(r.detail, /wired to this kit \(resolved from files, not run\)/);
  });
});
