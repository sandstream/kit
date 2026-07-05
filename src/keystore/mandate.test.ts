import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateIdentity,
  signWithIdentity,
  recordRevocation,
  rotateIdentity,
  identityId,
  loadRevocations,
} from "../identity.js";
import { appendAuditEventDirect } from "../audit.js";
import { keystoreRecordRevocation } from "./revoke.js";
import { hardwareRequired, policyRequiresHardware } from "./active.js";
import { existsSync, writeFileSync } from "node:fs";
import { signAttestation } from "../check-attestation.js";

// The mandate must be COMPREHENSIVE: with KIT_REQUIRE_HARDWARE_IDENTITY set and only a
// file key present, NO code path may emit a file-key signature — not policy sign, not the
// audit chain, not revocations. Each either fails closed (throws) or falls back to keyless.
describe("hardware mandate — no file-key signature escapes", () => {
  let idDir: string;
  let cwd: string;
  const saved = {
    req: process.env.KIT_REQUIRE_HARDWARE_IDENTITY,
    id: process.env.KIT_IDENTITY_DIR,
    anchor: process.env.KIT_AUDIT_ANCHOR,
  };

  beforeEach(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-mandate-id-"));
    cwd = mkdtempSync(join(tmpdir(), "kit-mandate-cwd-"));
    process.env.KIT_IDENTITY_DIR = idDir;
    process.env.KIT_AUDIT_ANCHOR = "0"; // don't touch the real ~/.kit anchor from tests
    delete process.env.KIT_REQUIRE_HARDWARE_IDENTITY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries({
      KIT_REQUIRE_HARDWARE_IDENTITY: saved.req,
      KIT_IDENTITY_DIR: saved.id,
      KIT_AUDIT_ANCHOR: saved.anchor,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(idDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("signWithIdentity refuses the file key under the mandate", () => {
    loadOrCreateIdentity(); // a file key exists (created BEFORE the mandate)
    assert.doesNotThrow(() => signWithIdentity("x"), "no mandate → file signing works");
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.throws(() => signWithIdentity("x"), /required|refusing to sign/i);
  });

  it("loadOrCreateIdentity refuses to MINT a file key under the mandate", () => {
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.throws(() => loadOrCreateIdentity(), /refusing to create a file identity/);
  });

  it("rotateIdentity refuses to re-mint a file key under the mandate", () => {
    loadOrCreateIdentity(); // an identity exists pre-mandate
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.throws(() => rotateIdentity(), /refusing to rotate into a file identity/);
  });

  it("keystoreRecordRevocation: file kid without mandate; fails closed under mandate", () => {
    const me = loadOrCreateIdentity().identity;
    const rec = keystoreRecordRevocation("kid_old", "compromised");
    assert.equal(rec.by, identityId(me.publicKey), "attributed to the active (file) kid");
    assert.equal(
      loadRevocations().some((r) => r.kid === "kid_old"),
      true,
    );
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.throws(() => keystoreRecordRevocation("kid_old2", "x"), /required/i);
  });

  it("attestation does NOT mint/use an Ed25519 file key under the mandate", async () => {
    loadOrCreateIdentity();
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    // preferEd25519 would normally use the file Ed25519 key; under the mandate that path
    // is refused, so the receipt is HMAC or "none" — never an ed25519 file-key signature —
    // and no attestation-ed25519 key file is created.
    const att = await signAttestation(
      {
        schema: "kit-check-attestation/v1",
        command: "check",
        timestamp: "2026-01-01T00:00:00Z",
        kit_version: "0.0.0",
        overall_ok: true,
        results: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
        scanners_ran: [],
      },
      { dir: idDir, preferEd25519: true },
    );
    assert.notEqual(att.sig_alg, "ed25519", "must not sign attestation with the file Ed25519 key");
    assert.equal(
      existsSync(join(idDir, "attestation-ed25519.key")),
      false,
      "no Ed25519 file key minted under the mandate",
    );
  });

  it("a .kit-policy require_hardware_identity mandate (no env) forces audit keyless", async () => {
    loadOrCreateIdentity();
    // Org policy at the repo root mandates hardware — NO env var set.
    writeFileSync(join(cwd, ".kit-policy.toml"), "version = 1\nrequire_hardware_identity = true\n");
    assert.equal(policyRequiresHardware(cwd), true);
    assert.equal(hardwareRequired(cwd), true, "policy alone triggers the effective mandate");
    assert.equal(hardwareRequired(idDir), false, "a dir without the policy is unaffected");

    // Audit append runs at `cwd` (where the policy lives) → the entry must be KEYLESS,
    // never file-signed, even though KIT_REQUIRE_HARDWARE_IDENTITY is unset.
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      assert.equal(
        await appendAuditEventDirect(
          { operation: "op-pol", environment: "dev", success: true },
          { cwd },
        ),
        true,
      );
    } finally {
      process.chdir(origCwd);
    }
    const line = JSON.parse(
      readFileSync(join(cwd, ".kit-audit.jsonl"), "utf-8").trim().split("\n").at(-1)!,
    ) as { operation: string; sig?: string };
    assert.equal(line.operation, "op-pol");
    assert.equal(line.sig, undefined, "policy-mandated entry must not carry a file-key signature");
  });

  it("fail-closed on a present-but-non-boolean require_hardware_identity (typo footgun)", () => {
    // `= 1` / `= "true"` are validation errors, but must NOT silently disable the mandate.
    writeFileSync(join(cwd, ".kit-policy.toml"), "version = 1\nrequire_hardware_identity = 1\n");
    assert.equal(policyRequiresHardware(cwd), true, "non-boolean present → mandate ON");
    // A strict false / absent is the only "not mandated".
    writeFileSync(
      join(cwd, ".kit-policy.toml"),
      "version = 1\nrequire_hardware_identity = false\n",
    );
    assert.equal(policyRequiresHardware(cwd), false);
    writeFileSync(join(cwd, ".kit-policy.toml"), "version = 1\n");
    assert.equal(policyRequiresHardware(cwd), false);
  });

  it("policy mandate applies from a SUBDIRECTORY (upward .kit-policy.toml search)", () => {
    // Policy at the repo root; kit invoked from a nested subdir. The mandate must still be
    // found (else a subdir invocation would silently skip a fleet policy → file signature).
    writeFileSync(join(cwd, ".kit-policy.toml"), "version = 1\nrequire_hardware_identity = true\n");
    const sub = join(cwd, "a", "b", "c");
    mkdirSync(sub, { recursive: true });
    assert.equal(policyRequiresHardware(sub), true, "found via ancestor walk");
    assert.equal(hardwareRequired(sub), true);
  });

  it("attestation under a POLICY-only mandate also refuses the Ed25519 file key", async () => {
    loadOrCreateIdentity();
    writeFileSync(join(cwd, ".kit-policy.toml"), "version = 1\nrequire_hardware_identity = true\n");
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      const att = await signAttestation(
        {
          schema: "kit-check-attestation/v1",
          command: "check",
          timestamp: "2026-01-01T00:00:00Z",
          kit_version: "0.0.0",
          overall_ok: true,
          results: { passed: 1, failed: 0, warnings: 0, skipped: 0 },
          scanners_ran: [],
        },
        { dir: cwd, preferEd25519: true },
      );
      assert.notEqual(att.sig_alg, "ed25519", "policy mandate must block the file Ed25519 path");
      assert.equal(existsSync(join(cwd, "attestation-ed25519.key")), false);
    } finally {
      process.chdir(origCwd);
    }
  });

  it("recordRevocation fails closed under the mandate (no file-key revocation)", () => {
    loadOrCreateIdentity();
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.throws(
      () => recordRevocation("kid_target", "compromised"),
      /required|refusing to sign/i,
    );
  });

  it("audit entries fall back to KEYLESS under the mandate, never file-signed", async () => {
    loadOrCreateIdentity();
    const lastEntry = () => {
      const content = readFileSync(join(cwd, ".kit-audit.jsonl"), "utf-8");
      return JSON.parse(content.trim().split("\n").at(-1)!) as {
        operation: string;
        sig?: string;
        kid?: string;
      };
    };

    // Without the mandate, the entry is signed by the file identity.
    assert.equal(
      await appendAuditEventDirect(
        { operation: "op-a", environment: "dev", success: true },
        { cwd },
      ),
      true,
    );
    const signed = lastEntry();
    assert.ok(signed.sig && signed.kid, "pre-mandate entry carries a file-key signature");

    // With the mandate + only a file key: the append still SUCCEEDS (best-effort) but the
    // new entry is KEYLESS — no file-key signature is emitted.
    process.env.KIT_REQUIRE_HARDWARE_IDENTITY = "1";
    assert.equal(
      await appendAuditEventDirect(
        { operation: "op-b", environment: "dev", success: true },
        { cwd },
      ),
      true,
      "append must not fail — the hash chain still protects the entry",
    );
    const keyless = lastEntry();
    assert.equal(keyless.operation, "op-b");
    assert.equal(keyless.sig, undefined, "the mandated entry must NOT carry a file-key signature");
    assert.equal(keyless.kid, undefined);
  });
});
