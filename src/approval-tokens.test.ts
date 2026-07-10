import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, identityId, recordRevocation } from "./identity.js";
import { resolveKeyStore } from "./keystore/index.js";
import { addPolicySigner, getSignersPath } from "./policy-trust.js";
import { mintApprovalToken, checkSignedApproval, APPROVAL_TOKENS_FILE } from "./approval-tokens.js";

let idDir: string;
let root: string;
let savedId: string | undefined;
let orgId: string;

const OP = "secrets.rotate";
const ENV = "prod";

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  root = mkdtempSync(join(tmpdir(), "kit-appr-"));
  savedId = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity();
  const pub = resolveKeyStore().store.publicKeyPem()!;
  orgId = identityId(pub);
  addPolicySigner(root, pub, "org"); // this identity is a trusted approval authority
});

afterEach(() => {
  if (savedId === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedId;
  for (const d of [idDir, root]) rmSync(d, { recursive: true, force: true });
});

describe("signed approval tokens", () => {
  it("a valid org-signed token grants the matching operation", () => {
    mintApprovalToken(OP, ENV, 3600, { root, dir: idDir });
    const r = checkSignedApproval({ operation: OP, environment: ENV }, root, { dir: idDir });
    assert.equal(r.approved, true, r.detail);
  });

  it("does not grant a different operation or environment", () => {
    mintApprovalToken(OP, ENV, 3600, { root, dir: idDir });
    assert.equal(
      checkSignedApproval({ operation: "other.op", environment: ENV }, root, { dir: idDir })
        .approved,
      false,
    );
    assert.equal(
      checkSignedApproval({ operation: OP, environment: "dev" }, root, { dir: idDir }).approved,
      false,
    );
  });

  it("does not grant an expired token", () => {
    mintApprovalToken(OP, ENV, 3600, { root, dir: idDir, now: new Date(1000) });
    // Evaluate far in the future → expired.
    const r = checkSignedApproval({ operation: OP, environment: ENV }, root, {
      dir: idDir,
      now: new Date(1000 + 3600_000 + 1),
    });
    assert.equal(r.approved, false);
  });

  it("fail-closed: a token whose signer is not an org authority is ignored", () => {
    mintApprovalToken(OP, ENV, 3600, { root, dir: idDir });
    // Remove the anchor so the signer is no longer a trusted authority.
    rmSync(getSignersPath(root), { force: true });
    assert.equal(
      checkSignedApproval({ operation: OP, environment: ENV }, root, { dir: idDir }).approved,
      false,
    );
  });

  it("fail-closed: a forged signature is rejected", () => {
    mintApprovalToken(OP, ENV, 3600, { root, dir: idDir });
    // Corrupt the stored token's signature.
    const p = join(root, APPROVAL_TOKENS_FILE);
    const tampered = {
      operation: OP,
      environment: ENV,
      kid: orgId,
      ts: new Date().toISOString(),
      expires: new Date(Date.now() + 3600_000).toISOString(),
      sig: "AA==",
    };
    writeFileSync(p, JSON.stringify(tampered) + "\n", "utf-8");
    assert.equal(
      checkSignedApproval({ operation: OP, environment: ENV }, root, { dir: idDir }).approved,
      false,
    );
  });

  it("fail-closed: a revoked approver's token is not honored", () => {
    mintApprovalToken(OP, ENV, 3600, { root, dir: idDir });
    // The approver self-revokes → the token must stop granting.
    recordRevocation(orgId, "compromised", idDir);
    assert.equal(
      checkSignedApproval({ operation: OP, environment: ENV }, root, { dir: idDir }).approved,
      false,
    );
  });

  it("no token store ⇒ not approved (falls through to interactive)", () => {
    const r = checkSignedApproval({ operation: OP, environment: ENV }, root, { dir: idDir });
    assert.equal(r.approved, false);
    assert.match(r.detail, /no approval tokens/);
  });
});
