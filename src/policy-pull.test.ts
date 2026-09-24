import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  readlinkSync,
  rmSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { loadOrCreateIdentity, identityId } from "./identity.js";
import { resolveKeyStore } from "./keystore/index.js";
import {
  POLICY_TEMPLATE,
  loadPolicy,
  canonicalPolicyBytes,
  policyFingerprint,
  getPolicyPath,
  getPolicySigPath,
  verifyPolicy,
  type PolicySignature,
} from "./policy-doc.js";
import { addPolicySigner, getSignersPath } from "./policy-trust.js";
import { applyPolicyPairAtomically, pullPolicy } from "./policy-pull.js";
import { evaluatePolicy } from "./policy-check.js";

let idDir: string;
let source: string;
let dest: string;
let savedId: string | undefined;

/** Sign the policy already written in `dir` with the active identity; returns the signer's PEM. */
function signPolicyInDir(dir: string): string {
  const doc = loadPolicy(dir)!;
  const pub = resolveKeyStore().store.publicKeyPem()!;
  const record: PolicySignature = {
    kid: identityId(pub),
    sig: resolveKeyStore().store.sign(canonicalPolicyBytes(doc)).toString("base64"),
    ts: new Date().toISOString(),
    fingerprint: policyFingerprint(doc),
  };
  writeFileSync(getPolicySigPath(dir), JSON.stringify(record, null, 2) + "\n", "utf-8");
  return pub;
}

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  source = mkdtempSync(join(tmpdir(), "kit-pull-src-"));
  dest = mkdtempSync(join(tmpdir(), "kit-pull-dest-"));
  savedId = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity();
});

afterEach(() => {
  if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedId;
  for (const d of [idDir, source, dest]) rmSync(d, { recursive: true, force: true });
});

describe("pullPolicy", () => {
  it("applies a source policy that verifies against the LOCAL anchor", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org"); // local anchor trusts the signer

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.status, "applied");
    assert.ok(existsSync(getPolicyPath(dest)));
    assert.ok(existsSync(getPolicySigPath(dest)));
    // The applied policy verifies in its new home.
    assert.equal(verifyPolicy(dest).status, "valid");
  });

  it("fail-closed (no write) when the source policy was tampered after signing", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org");
    // Tamper AFTER signing → a real content change (a new key, not a comment) so the canonical
    // bytes and thus the fingerprint no longer match the signature.
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE + '\nx_tamper = "evil"\n', "utf-8");

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, false);
    assert.equal(r.status, "invalid");
    assert.equal(existsSync(getPolicyPath(dest)), false, "must not write an unverified policy");
  });

  it("fail-closed 'no-anchor' when the destination has no local trust anchor (root trust is never fetched)", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    signPolicyInDir(source);
    // No addPolicySigner(dest, …) → dest has no .kit-policy.signers.

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, false);
    assert.equal(r.status, "no-anchor");
    assert.equal(existsSync(getPolicyPath(dest)), false);
  });
});

describe("pullPolicy org trust boundary", () => {
  it("refuses this machine's signer when the destination org anchor trusts another key", async () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    signPolicyInDir(source);
    const { publicKey } = generateKeyPairSync("ed25519");
    const orgPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    addPolicySigner(dest, orgPem, "org");

    const result = pullPolicy(source, dest);
    assert.equal(result.ok, false);
    assert.equal(result.status, "unverifiable");
    assert.equal(existsSync(getPolicyPath(dest)), false);
    assert.equal(existsSync(getPolicySigPath(dest)), false);

    writeFileSync(getPolicyPath(dest), POLICY_TEMPLATE, "utf-8");
    signPolicyInDir(dest);
    assert.equal(verifyPolicy(dest).status, "unverifiable");
    const check = await evaluatePolicy(dest, { strict: true });
    assert.equal(check.ok, false);
    assert.equal(check.signature?.status, "fail");
  });

  it("refuses an empty org anchor even when this machine signed the source", async () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    signPolicyInDir(source);
    writeFileSync(getSignersPath(dest), '{"signers":[]}\n');

    const result = pullPolicy(source, dest);
    assert.equal(result.ok, false);
    assert.equal(result.status, "no-anchor");
    assert.equal(existsSync(getPolicyPath(dest)), false);

    writeFileSync(getPolicyPath(dest), POLICY_TEMPLATE, "utf-8");
    signPolicyInDir(dest);
    const check = await evaluatePolicy(dest, { strict: true });
    assert.equal(check.ok, false);
    assert.equal(check.signature?.status, "fail");
  });
});

describe("pullPolicy source handling", () => {
  it("does not echo credentials from an unsupported source URL", () => {
    const credential = "synthetic_source_credential_123";
    const result = pullPolicy(`https://operator:${credential}@example.invalid/policy`, dest);
    assert.equal(result.status, "no-source");
    assert.doesNotMatch(result.detail, new RegExp(credential));
  });

  it("'no-source' when the source has no signed policy pair", () => {
    addPolicySigner(dest, resolveKeyStore().store.publicKeyPem()!, "org");
    const r = pullPolicy(source, dest);
    assert.equal(r.ok, false);
    assert.equal(r.status, "no-source");
  });

  it("NEVER overwrites the local trust anchor from the source (decision §6.1)", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org");
    const localAnchorBefore = readFileSync(getSignersPath(dest), "utf-8");
    // The source also ships a (different/adversarial) anchor — it must be ignored.
    writeFileSync(getSignersPath(source), JSON.stringify({ signers: [] }) + "\n", "utf-8");

    const r = pullPolicy(source, dest);
    assert.equal(r.ok, true, r.detail);
    assert.equal(
      readFileSync(getSignersPath(dest), "utf-8"),
      localAnchorBefore,
      "the local anchor must be untouched — root trust is never pulled",
    );
  });

  it("resolves a file:// source URI", () => {
    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    const pub = signPolicyInDir(source);
    addPolicySigner(dest, pub, "org");

    const r = pullPolicy(`file://${source}`, dest);
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.status, "applied");
  });

  it(
    "refuses a FIFO source without waiting for a writer",
    { skip: process.platform === "win32" },
    () => {
      const created = spawnSync("mkfifo", [getPolicyPath(source)], { encoding: "utf8" });
      assert.equal(created.status, 0, created.stderr);
      writeFileSync(getPolicySigPath(source), "not a signature\n");
      addPolicySigner(dest, resolveKeyStore().store.publicKeyPem()!, "org");

      const run = spawnSync(
        process.execPath,
        [
          ...process.execArgv.filter((arg) => !arg.startsWith("--test")),
          "--input-type=module",
          "--eval",
          "const { pullPolicy } = await import(process.argv[1]); process.stdout.write(JSON.stringify(pullPolicy(process.argv[2], process.argv[3])));",
          new URL("./policy-pull.js", import.meta.url).href,
          source,
          dest,
        ],
        { encoding: "utf8", timeout: 2_000, env: process.env },
      );
      assert.equal(run.error, undefined, String(run.error));
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout) as ReturnType<typeof pullPolicy>;
      assert.equal(result.ok, false);
      assert.equal(result.status, "no-source");
      assert.match(result.detail, /regular file/i);
      assert.equal(existsSync(getPolicyPath(dest)), false);
    },
  );
});

describe("pullPolicy atomic application", () => {
  it("never throws or leaves a mixed policy/signature pair when apply cannot complete", () => {
    const oldPolicy = POLICY_TEMPLATE.replace("require_triage = true", "require_triage = false");
    writeFileSync(getPolicyPath(dest), oldPolicy, "utf-8");
    const pub = signPolicyInDir(dest);
    addPolicySigner(dest, pub, "org");
    assert.equal(verifyPolicy(dest).status, "valid");

    writeFileSync(getPolicyPath(source), POLICY_TEMPLATE, "utf-8");
    signPolicyInDir(source);
    const oldPolicyBytes = readFileSync(getPolicyPath(dest));
    const oldSignatureBytes = readFileSync(getPolicySigPath(dest));
    chmodSync(getPolicySigPath(dest), 0o400);

    let result: ReturnType<typeof pullPolicy> | undefined;
    assert.doesNotThrow(() => {
      result = pullPolicy(source, dest);
    });
    chmodSync(getPolicySigPath(dest), 0o600);

    assert.equal(verifyPolicy(dest).status, "valid", "a failed apply must remain fail-closed");
    if (!result?.ok) {
      assert.deepEqual(readFileSync(getPolicyPath(dest)), oldPolicyBytes);
      assert.deepEqual(readFileSync(getPolicySigPath(dest)), oldSignatureBytes);
    } else {
      assert.deepEqual(readFileSync(getPolicyPath(dest)), readFileSync(getPolicyPath(source)));
      assert.deepEqual(
        readFileSync(getPolicySigPath(dest)),
        readFileSync(getPolicySigPath(source)),
      );
    }
  });
});

describe("pullPolicy rollback of prior files", () => {
  it("restores the exact prior pair when the final policy rename fails", () => {
    const oldPolicy = Buffer.from("old policy bytes\n");
    const oldSignature = Buffer.from("old signature bytes\n");
    writeFileSync(getPolicyPath(dest), oldPolicy);
    writeFileSync(getPolicySigPath(dest), oldSignature);
    let calls = 0;

    const result = applyPolicyPairAtomically(
      dest,
      Buffer.from("new policy bytes\n"),
      Buffer.from("new signature bytes\n"),
      (from, to) => {
        calls++;
        if (calls === 2) {
          const error = Object.assign(new Error("injected final rename failure"), { code: "EIO" });
          throw error;
        }
        renameSync(from, to);
      },
    );

    assert.equal(result.ok, false);
    assert.match(result.detail, /previous pair retained/);
    assert.deepEqual(readFileSync(getPolicyPath(dest)), oldPolicy);
    assert.deepEqual(readFileSync(getPolicySigPath(dest)), oldSignature);
  });

  it("restores a prior signature symlink without writing through its target", () => {
    const oldPolicy = Buffer.from("old policy bytes\n");
    const oldSignature = Buffer.from("old signature bytes\n");
    const target = join(dest, "signature-target");
    writeFileSync(getPolicyPath(dest), oldPolicy);
    writeFileSync(target, oldSignature);
    symlinkSync("signature-target", getPolicySigPath(dest));
    let calls = 0;

    const result = applyPolicyPairAtomically(
      dest,
      Buffer.from("new policy bytes\n"),
      Buffer.from("new signature bytes\n"),
      (from, to) => {
        calls++;
        if (calls === 2) throw Object.assign(new Error("injected failure"), { code: "EIO" });
        renameSync(from, to);
      },
    );

    assert.equal(result.ok, false);
    assert.equal(lstatSync(getPolicySigPath(dest)).isSymbolicLink(), true);
    assert.equal(readlinkSync(getPolicySigPath(dest)), "signature-target");
    assert.deepEqual(readFileSync(target), oldSignature);
    assert.deepEqual(readFileSync(getPolicyPath(dest)), oldPolicy);
  });
});
