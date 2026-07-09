import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../identity.js";
import { PROFILE_FILE } from "./schema.js";
import { signProfile, verifyProfileSignature, verifiedScope, getProfileSigPath } from "./sign.js";

let idDir: string;
let proj: string;
let savedIdEnv: string | undefined;

const SCOPED = `version = 1
name = "acme"
[scope]
egress = ["api.acme.com"]
fs = ["."]
secrets = ["DATABASE_URL"]
`;

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  proj = mkdtempSync(join(tmpdir(), "kit-profsign-"));
  savedIdEnv = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  loadOrCreateIdentity(); // mint a file identity under idDir
});

afterEach(() => {
  if (savedIdEnv === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedIdEnv;
  rmSync(idDir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

describe("signProfile / verifyProfileSignature", () => {
  it("signs a profile and verifies it via the local identity", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    const res = await signProfile(proj);
    assert.equal(res.ok, true);
    assert.ok(existsSync(getProfileSigPath(proj)));
    assert.match(res.fingerprint ?? "", /^sha256:/);

    const v = await verifyProfileSignature(proj);
    assert.equal(v.status, "valid");
    assert.equal(v.via, "local");
  });

  it("refuses to sign when no profile is declared", async () => {
    const res = await signProfile(proj);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /no profile/);
  });

  it("reports unsigned when there is no .kit-profile.sig", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    const v = await verifyProfileSignature(proj);
    assert.equal(v.status, "unsigned");
  });

  it("detects tampering — a changed profile invalidates the signature", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    // Change a signed field (name is part of the canonical bytes).
    writeFileSync(join(proj, PROFILE_FILE), SCOPED.replace("acme", "evil-corp"));
    const v = await verifyProfileSignature(proj);
    assert.equal(v.status, "invalid");
  });

  it("re-signing after an edit restores validity (generated is excluded from the signed bytes)", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    writeFileSync(join(proj, PROFILE_FILE), SCOPED.replace("acme", "acme-web"));
    assert.equal((await verifyProfileSignature(proj)).status, "invalid");
    await signProfile(proj);
    assert.equal((await verifyProfileSignature(proj)).status, "valid");
  });
});

describe("verifiedScope (Pillar 3 hook — fail-closed)", () => {
  it("returns the scope only when the signature is valid", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    const scope = await verifiedScope(proj);
    assert.deepEqual(scope?.egress, ["api.acme.com"]);
    assert.deepEqual(scope?.fs, ["."]);
  });

  it("returns null when the profile is unsigned (unsigned scope grants nothing)", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    assert.equal(await verifiedScope(proj), null);
  });

  it("returns null when the profile was tampered after signing", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    writeFileSync(join(proj, PROFILE_FILE), SCOPED.replace("api.acme.com", "evil.example.com"));
    assert.equal(await verifiedScope(proj), null);
  });

  it("returns null when a signed profile declares no scope", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\nname = "no-scope"\n`);
    await signProfile(proj);
    assert.equal((await verifyProfileSignature(proj)).status, "valid");
    assert.equal(await verifiedScope(proj), null);
  });
});
