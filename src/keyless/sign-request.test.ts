import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, recordRevocation } from "../identity.js";
import { PROFILE_FILE } from "../profile/schema.js";
import { signProfile } from "../profile/sign.js";
import { signOutbound, verifyInbound, hostRequiresSigning } from "./sign-request.js";
import type { SignableRequest } from "./http-sig.js";

let idDir: string;
let proj: string;
let savedIdEnv: string | undefined;

const REQ: SignableRequest = {
  method: "POST",
  url: "https://api.acme.com/v1/charge",
  headers: { "content-type": "application/json" },
};

const withSign = `version = 1\n[scope]\negress = ["api.acme.com"]\nsign = ["api.acme.com"]\n`;

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  proj = mkdtempSync(join(tmpdir(), "kit-keyless-"));
  savedIdEnv = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity();
});

afterEach(() => {
  if (savedIdEnv === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedIdEnv;
  rmSync(idDir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

describe("keyless hostRequiresSigning", () => {
  it("matches exact and suffix hosts, empty list matches nothing", () => {
    assert.equal(hostRequiresSigning("https://api.acme.com/x", ["api.acme.com"]), true);
    assert.equal(hostRequiresSigning("https://a.internal.io/x", [".internal.io"]), true);
    assert.equal(hostRequiresSigning("https://api.acme.com/x", []), false);
    assert.equal(hostRequiresSigning("https://other.com/x", ["api.acme.com"]), false);
  });
});

describe("keyless signOutbound", () => {
  it("not-required when the host is not declared keyless", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope]\negress = ["api.acme.com"]\n`);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir });
    assert.equal(r.status, "not-required");
  });

  it("denied (fail-closed) when the host is keyless but the scope is UNVERIFIED", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign); // written but NOT signed
    const r = await signOutbound(REQ, { root: proj, dir: idDir });
    assert.equal(r.status, "denied");
    assert.match(r.detail, /unverified/);
  });

  it("signs a keyless host when the scope is verified, and verifyInbound accepts it", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir, now: new Date(1_000_000_000_000) });
    assert.equal(r.status, "signed", r.detail);
    if (r.status !== "signed") return;
    assert.match(r.keyid, /^kid_/);
    const v = verifyInbound(
      REQ,
      { signatureInput: r.headers["Signature-Input"], signature: r.headers.Signature },
      { dir: idDir, now: new Date(1_000_000_060_000) },
    );
    assert.equal(v.valid, true, v.detail);
  });

  it("verifyInbound rejects a tampered request", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir, now: new Date(1_000_000_000_000) });
    assert.equal(r.status, "signed");
    if (r.status !== "signed") return;
    const v = verifyInbound(
      { ...REQ, url: "https://api.acme.com/v1/refund" },
      { signatureInput: r.headers["Signature-Input"], signature: r.headers.Signature },
      { dir: idDir, now: new Date(1_000_000_060_000) },
    );
    assert.equal(v.valid, false);
  });

  it("denied when the signing identity is revoked (fail-closed)", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const id = loadOrCreateIdentity().identity;
    recordRevocation(id.id, "compromised", idDir);
    const r = await signOutbound(REQ, { root: proj, dir: idDir });
    assert.equal(r.status, "denied");
    assert.match(r.detail, /revoked/);
  });

  it("verifyInbound rejects a signature from a revoked signer", async () => {
    writeFileSync(join(proj, PROFILE_FILE), withSign);
    await signProfile(proj);
    const r = await signOutbound(REQ, { root: proj, dir: idDir, now: new Date(1_000_000_000_000) });
    assert.equal(r.status, "signed");
    if (r.status !== "signed") return;
    recordRevocation(r.keyid, "compromised", idDir);
    const v = verifyInbound(
      REQ,
      { signatureInput: r.headers["Signature-Input"], signature: r.headers.Signature },
      { dir: idDir, now: new Date(1_000_000_060_000) },
    );
    assert.equal(v.valid, false);
  });
});
