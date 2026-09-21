import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityId, loadOrCreateIdentity } from "./identity.js";
import { resolveKeyStore } from "./keystore/index.js";
import {
  canonicalPolicyBytes,
  getPolicyPath,
  getPolicySigPath,
  loadPolicy,
  POLICY_TEMPLATE,
  policyFingerprint,
  verifyPolicy,
} from "./policy-doc.js";
import { pullPolicy, type PullResult } from "./policy-pull.js";
import { addPolicySigner } from "./policy-trust.js";

let root: string;
let dest: string;
let source6: string;
let source7: string;
let savedIdentity: string | undefined;

function publish(dir: string, revision: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(getPolicyPath(dir), `${POLICY_TEMPLATE}\nrevision = ${revision}\n`);
  const policy = loadPolicy(dir)!;
  const { store } = resolveKeyStore();
  writeFileSync(
    getPolicySigPath(dir),
    JSON.stringify({
      kid: identityId(store.publicKeyPem()!),
      sig: store.sign(canonicalPolicyBytes(policy)).toString("base64"),
      ts: new Date().toISOString(),
      fingerprint: policyFingerprint(policy),
    }),
  );
}

function competingPull(source: string, destination = dest): PullResult {
  const run = spawnSync(
    process.execPath,
    [
      ...process.execArgv.filter((arg) => !arg.startsWith("--test")),
      "--input-type=module",
      "--eval",
      "const { pullPolicy } = await import(process.argv[1]); process.stdout.write(JSON.stringify(pullPolicy(process.argv[2], process.argv[3])));",
      new URL("./policy-pull.js", import.meta.url).href,
      source,
      destination,
    ],
    { encoding: "utf-8", timeout: 10_000, env: process.env },
  );
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout) as PullResult;
}

function pair(): Buffer[] {
  return [readFileSync(getPolicyPath(dest)), readFileSync(getPolicySigPath(dest))];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kit-policy-lock-test-"));
  dest = join(root, "dest");
  source6 = join(root, "source6");
  source7 = join(root, "source7");
  savedIdentity = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = join(root, "identity");
  loadOrCreateIdentity();
  publish(dest, 5);
  publish(source6, 6);
  publish(source7, 7);
  addPolicySigner(dest, resolveKeyStore().store.publicKeyPem()!, "org");
});

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  if (savedIdentity === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedIdentity;
  rmSync(root, { recursive: true, force: true });
});

describe("policy pull destination lock", () => {
  for (const alias of [false, true]) {
    it(`serializes revision comparison and installation across processes (alias=${alias})`, () => {
      const destination = alias ? join(root, "dest-alias") : dest;
      if (alias) symlinkSync(dest, destination, "dir");
      let competitor: PullResult | undefined;
      let observedRevision = 5;
      const result = pullPolicy(source6, dest, {
        afterVerify: () => {
          competitor = competingPull(source7, destination);
          observedRevision = loadPolicy(dest)!.revision!;
        },
      });
      assert.equal(result.status, "applied", result.detail);
      const finalRevision = loadPolicy(dest)!.revision!;
      assert.ok(
        finalRevision >= observedRevision,
        `concurrent pulls rolled revision ${observedRevision} back to ${finalRevision}; competitor=${competitor?.status}`,
      );
      assert.ok(competitor);
      assert.equal(competitor.ok, false);
      assert.equal(competitor.status, "apply-failed");
      assert.match(competitor.detail, /lock.*busy/i);
      assert.equal(verifyPolicy(dest).status, "valid");
      assert.equal(competingPull(source7, destination).status, "applied");
      const installed = pair();
      assert.equal(pullPolicy(source6, dest).status, "stale-revision");
      assert.deepEqual(pair(), installed);
      assert.equal(competingPull(source7).status, "applied", "stale refusal releases the lock");
    });
  }
});

describe("policy pull lock lifecycle", () => {
  for (const kind of ["directory", "file", "symlink"]) {
    it(`refuses an existing ${kind} lock without removing it`, () => {
      const lock = join(dest, ".kit-policy-pull.lock");
      if (kind === "directory") mkdirSync(lock);
      else if (kind === "file") writeFileSync(lock, "abandoned lock\n");
      else symlinkSync(join(root, "missing-lock-target"), lock);
      if (kind !== "symlink") utimesSync(lock, new Date(0), new Date(0));
      const lockBefore = fs.lstatSync(lock);
      const before = pair();
      const result = pullPolicy(source6, dest);
      assert.equal(result.ok, false);
      assert.equal(result.status, "apply-failed");
      assert.match(result.detail, /lock.*busy/i);
      assert.deepEqual(pair(), before);
      assert.deepEqual(fs.lstatSync(lock), lockBefore);
      rmSync(lock, { recursive: true });
      assert.equal(competingPull(source6).status, "applied");
    });
  }

  it("releases the lock when a post-verification operation throws", () => {
    const before = pair();
    const result = pullPolicy(source6, dest, {
      afterVerify: () => {
        throw Object.assign(new Error("injected failure"), { code: "EIO" });
      },
    });
    assert.equal(result.status, "apply-failed");
    assert.match(result.detail, /EIO/);
    assert.deepEqual(pair(), before);
    assert.equal(existsSync(join(dest, ".kit-policy-pull.lock")), false);
    assert.equal(competingPull(source7).status, "applied");
  });

  it("allows a competing pull into a different destination", () => {
    const other = join(root, "other");
    publish(other, 5);
    addPolicySigner(other, resolveKeyStore().store.publicKeyPem()!, "org");
    let competitor: PullResult | undefined;
    const result = pullPolicy(source6, dest, {
      afterVerify: () => {
        competitor = competingPull(source7, other);
      },
    });
    assert.equal(result.status, "applied", result.detail);
    assert.equal(competitor?.status, "applied");
    assert.equal(loadPolicy(dest)!.revision, 6);
    assert.equal(loadPolicy(other)!.revision, 7);
  });
});

describe("policy pull lock during pair replacement", () => {
  for (const failRename of [false, true]) {
    it(`holds the lock between signature and policy renames (failure=${failRename})`, () => {
      const before = pair();
      const renameFile = fs.renameSync;
      let competitor: PullResult | undefined;
      let transitionalStatus: string | undefined;
      mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
        if (to === getPolicyPath(dest) && failRename) {
          throw Object.assign(new Error("injected policy rename failure"), { code: "EIO" });
        }
        renameFile(from, to);
        if (to === getPolicySigPath(dest)) {
          transitionalStatus = verifyPolicy(dest).status;
          competitor = competingPull(source7);
        }
      });
      syncBuiltinESMExports();
      const result = pullPolicy(source6, dest);
      mock.restoreAll();
      syncBuiltinESMExports();
      assert.equal(transitionalStatus, "invalid", "interrupted pair must fail closed");
      assert.ok(competitor);
      assert.equal(competitor.status, "apply-failed");
      assert.match(competitor.detail, /lock.*busy/i);
      assert.equal(result.status, failRename ? "apply-failed" : "applied", result.detail);
      if (failRename) assert.deepEqual(pair(), before, "rollback retains the exact previous pair");
      assert.equal(verifyPolicy(dest).status, "valid");
      assert.equal(existsSync(join(dest, ".kit-policy-pull.lock")), false);
      assert.equal(competingPull(source7).status, "applied");
    });
  }
});

describe("policy pull lock filesystem errors", () => {
  it("refuses installation when the destination lock cannot be created", () => {
    const before = pair();
    mock.method(fs, "mkdirSync", () => {
      throw Object.assign(new Error("injected lock creation failure"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    const result = pullPolicy(source6, dest);
    mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(result.status, "apply-failed");
    assert.match(result.detail, /lock.*unavailable.*EACCES/i);
    assert.deepEqual(pair(), before);
    assert.equal(existsSync(join(dest, ".kit-policy-pull.lock")), false);
    assert.equal(competingPull(source7).status, "applied");
  });

  it("reports failed lock cleanup and keeps subsequent pulls closed", () => {
    mock.method(fs, "rmdirSync", () => {
      throw Object.assign(new Error("injected lock cleanup failure"), { code: "EACCES" });
    });
    syncBuiltinESMExports();
    const result = pullPolicy(source6, dest);
    mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(result.ok, false);
    assert.equal(result.status, "apply-failed");
    assert.match(result.detail, /EACCES.*inspect.*policy.*lock/i);
    assert.equal(loadPolicy(dest)!.revision, 6);
    assert.equal(verifyPolicy(dest).status, "valid");
    const installed = pair();
    const next = competingPull(source7);
    assert.equal(next.status, "apply-failed");
    assert.match(next.detail, /lock.*busy/i);
    assert.deepEqual(pair(), installed);
    fs.rmdirSync(join(dest, ".kit-policy-pull.lock"));
    assert.equal(competingPull(source7).status, "applied");
  });
});
