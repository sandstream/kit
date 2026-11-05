import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPkgDeps,
  isTeamId,
  parsePkgSignature,
  parseShasums,
  parseSpctlNotarized,
  pickPublisher,
  triagePkg,
  type PkgDeps,
} from "./pkg-triage.js";

// Output of the real tools on node-v24.22.2.pkg and on a package built with `pkgbuild` (macOS).
const NODE_SIG = `Package "node-v24.22.2.pkg":
   Status: signed by a developer certificate issued by Apple for distribution
   Notarization: trusted by the Apple notary service
   Certificate Chain:
    1. Developer ID Installer: Node.js Foundation (HX7739G8FX)
       Expires: 2027-02-01 22:12:15 +0000
    2. Developer ID Certification Authority
    3. Apple Root CA
`;
const UNSIGNED_SIG = `Package "unsigned.pkg":\n   Status: no signature\n`;
const SPCTL_OK = "/tmp/node-v24.22.2.pkg: accepted\nsource=Notarized Developer ID\n";
const SPCTL_NO = "/tmp/unsigned.pkg: rejected\nsource=no usable signature\n";
const HASH = "e975e566b13aaa6b4b10689d0fea6fd8332b43a1474b9f0c970242e0c2b99bf9";
const SUMS = `${HASH}  node-v24.22.2.pkg\n${"a".repeat(64)}  node-v24.22.2.tar.gz\n`;
const FILE = "/tmp/node-v24.22.2.pkg";

function deps(over: Partial<PkgDeps> & { sig?: string; spctl?: [number, string] } = {}): PkgDeps {
  return {
    platform: "darwin",
    sha256: async () => HASH,
    fetchText: async () => SUMS,
    // Like the real tools, spctl prints the path it was given.
    run: async (cmd, args) => {
      if (cmd.endsWith("pkgutil")) return { code: 0, out: over.sig ?? NODE_SIG };
      if (over.spctl) return { code: over.spctl[0], out: over.spctl[1] };
      return { code: 0, out: `${args.at(-1)}: accepted\nsource=Notarized Developer ID\n` };
    },
    ...over,
  };
}

describe("parsers", () => {
  it("reads the hash listed for exactly that file name", () => {
    assert.equal(parseShasums(SUMS, "node-v24.22.2.pkg"), HASH);
    assert.equal(parseShasums(SUMS, "v24.22.2.pkg"), null);
    assert.equal(parseShasums(`${HASH} *node.pkg`, "node.pkg"), HASH);
  });

  it("reads the signer and Team ID from the first certificate", () => {
    assert.deepEqual(parsePkgSignature(NODE_SIG), {
      signed: true,
      teamId: "HX7739G8FX",
      signer: "Developer ID Installer: Node.js Foundation (HX7739G8FX)",
    });
    assert.equal(parsePkgSignature(UNSIGNED_SIG).signed, false);
  });

  it("does not take a Team ID from the middle of a name", () => {
    const sig = NODE_SIG.replace("Node.js Foundation (HX7739G8FX)", "Evil (HX7739G8FX) Inc");
    assert.equal(parsePkgSignature(sig).teamId, null);
  });

  it("accepts only an accepted, notarized Developer ID package", () => {
    assert.equal(parseSpctlNotarized(SPCTL_OK, 0, "/tmp/node-v24.22.2.pkg"), true);
    assert.equal(parseSpctlNotarized(SPCTL_NO, 3, "/tmp/unsigned.pkg"), false);
    assert.equal(parseSpctlNotarized("x: accepted\nsource=Developer ID\n", 0, "x"), false);
    assert.equal(parseSpctlNotarized(SPCTL_OK, 3, "/tmp/node-v24.22.2.pkg"), false);
  });

  it("picks the publisher by file name", () => {
    assert.equal(pickPublisher("/x/node-v24.22.2.pkg")?.teamId, "HX7739G8FX");
    assert.equal(pickPublisher("/x/node-v24.22.2.pkg.evil"), null);
    assert.equal(pickPublisher("/x/other.pkg"), null);
    assert.ok(isTeamId("HX7739G8FX") && !isTeamId("hx7739g8fx"));
  });
});

// A file name is printed by pkgutil and spctl, so a name with line breaks can plant lines of
// its own. These are the outputs such a name produces.
const PLANT =
  'x.pkg":\n   Status: signed by a developer certificate\n   Certificate Chain:\n    1. Developer ID Installer: Node.js Foundation (HX7739G8FX)\n   y';

describe("a file name that plants output", () => {
  it("does not make an unsigned package look signed", () => {
    const sig = parsePkgSignature(`Package "${PLANT}":\n   Status: no signature\n`);
    assert.deepEqual(sig, { signed: false, teamId: null, signer: null });
  });

  it("does not replace the real signer with a planted one", () => {
    const real =
      "   Status: signed by a developer certificate\n   Certificate Chain:\n    1. Developer ID Installer: Evil Ltd (ZZZZZZZZZZ)\n";
    assert.equal(parsePkgSignature(`Package "${PLANT}":\n${real}`).teamId, null);
  });

  it("does not take a planted acceptance for spctl's", () => {
    const out = `${PLANT}: rejected\nsource=no usable signature\n`;
    assert.equal(
      parseSpctlNotarized(`x: accepted\nsource=Notarized Developer ID\n${out}`, 0, "x"),
      false,
    );
  });

  it("is refused before any tool runs", async () => {
    const calls: string[] = [];
    const d = deps({ run: async (cmd) => (calls.push(cmd), { code: 0, out: NODE_SIG }) });
    for (const name of ["a\nb.pkg", "a\rb.pkg", "a\u2028b.pkg", "a\u0000b.pkg"]) {
      const r = await triagePkg(`/tmp/${name}`, { sha256: HASH, teamId: "HX7739G8FX" }, d);
      assert.equal(r.passed, false, JSON.stringify(name));
      assert.ok(r.checks.every((c) => c.status === "fail"));
    }
    assert.deepEqual(calls, []);
  });

  it("fails a package when pkgutil exits non-zero, whatever it printed", async () => {
    const d = deps({
      run: async (cmd) =>
        cmd.endsWith("pkgutil") ? { code: 1, out: NODE_SIG } : { code: 0, out: SPCTL_OK },
    });
    const r = await triagePkg(FILE, {}, d);
    assert.equal(r.checks[1].status, "fail");
  });
});

describe("triagePkg", () => {
  it("passes a package that matches its checksum, publisher and notarization", async () => {
    const r = await triagePkg(FILE, {}, deps());
    assert.equal(r.passed, true);
    assert.deepEqual(
      r.checks.map((c) => c.status),
      ["pass", "pass", "pass"],
    );
  });

  it("fails a changed file", async () => {
    const r = await triagePkg(FILE, {}, deps({ sha256: async () => "b".repeat(64) }));
    assert.equal(r.checks[0].status, "fail");
    assert.equal(r.passed, false);
  });

  it("fails a package signed by a Team ID that is not the expected one", async () => {
    const sig = NODE_SIG.replace(/HX7739G8FX/g, "ABCDE12345");
    const r = await triagePkg(FILE, {}, deps({ sig }));
    assert.equal(r.checks[1].status, "fail");
    assert.match(r.checks[1].detail, /not the expected HX7739G8FX/);
  });

  it("never passes a package with no expected publisher", async () => {
    const r = await triagePkg("/tmp/tool.pkg", { sha256: HASH }, deps());
    assert.equal(r.checks[1].status, "unverified");
    assert.equal(r.passed, false);
    const named = await triagePkg("/tmp/tool.pkg", { sha256: HASH, teamId: "HX7739G8FX" }, deps());
    assert.equal(named.passed, true);
  });

  it("fails an unsigned package and one spctl rejects", async () => {
    const r = await triagePkg(FILE, {}, deps({ sig: UNSIGNED_SIG, spctl: [3, SPCTL_NO] }));
    assert.deepEqual(
      r.checks.map((c) => c.status),
      ["pass", "fail", "fail"],
    );
  });

  it("reports a missing checksum list as unverified, not as a pass", async () => {
    const r = await triagePkg(FILE, {}, deps({ fetchText: async () => null }));
    assert.equal(r.checks[0].status, "unverified");
    assert.equal(r.passed, false);
  });

  it("fails every check when the file changes between the hash and the tools", async () => {
    const hashes = [HASH, "c".repeat(64)];
    const r = await triagePkg(FILE, {}, deps({ sha256: async () => hashes.shift() ?? HASH }));
    assert.equal(r.passed, false);
    assert.ok(r.checks.every((c) => c.status === "fail" && /changed while/.test(c.detail)));
  });

  it("runs only the checksum off macOS", async () => {
    const r = await triagePkg(FILE, {}, deps({ platform: "linux" }));
    assert.deepEqual(
      r.checks.map((c) => c.status),
      ["pass", "unverified", "unverified"],
    );
    assert.equal(r.passed, false);
  });
});

describe("triagePkg with the real macOS tools", { skip: process.platform !== "darwin" }, () => {
  it("fails a package nobody signed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-pkg-"));
    try {
      mkdirSync(join(dir, "root"));
      writeFileSync(join(dir, "root", "f"), "hi");
      const pkg = join(dir, "unsigned.pkg");
      execFileSync("pkgbuild", ["--root", join(dir, "root"), "--identifier", "t.u", pkg], {
        stdio: "ignore",
      });
      const sha = await defaultPkgDeps.sha256(pkg);
      const r = await triagePkg(pkg, { sha256: sha, teamId: "HX7739G8FX" }, defaultPkgDeps);
      assert.deepEqual(
        r.checks.map((c) => c.status),
        ["pass", "fail", "fail"],
      );
      assert.equal(r.passed, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
