import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadOrCreateIdentity } from "../identity.js";
import { PROFILE_FILE } from "../profile/schema.js";
import { signProfile } from "../profile/sign.js";
import { profileBrokerPolicy } from "./profile-policy.js";

let idDir: string;
let proj: string;
let savedIdEnv: string | undefined;

const SCOPED = `version = 1
[scope]
egress = ["api.acme.com"]
fs = ["src", "dist"]
secrets = ["DATABASE_URL"]
`;

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  proj = mkdtempSync(join(tmpdir(), "kit-profpol-"));
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

describe("profileBrokerPolicy", () => {
  it("regime none when no profile is declared", async () => {
    const r = await profileBrokerPolicy(proj);
    assert.equal(r.regime, "none");
    assert.equal(r.policy, null);
  });

  it("regime none when the profile declares no [scope]", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\nname = "x"\n`);
    assert.equal((await profileBrokerPolicy(proj)).regime, "none");
  });

  it("maps a verified [scope] onto a BrokerPolicy (fs paths resolved to roots)", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    const r = await profileBrokerPolicy(proj);
    assert.equal(r.regime, "active");
    assert.deepEqual(r.policy?.egress.allow, ["api.acme.com"]);
    assert.equal(r.policy?.fs.root, resolve(proj, "src"));
    assert.deepEqual(r.policy?.fs.roots, [resolve(proj, "dist")]);
    assert.deepEqual(r.policy?.env.declared, ["DATABASE_URL"]);
  });

  it("active + null policy (default-deny) when the scope is declared but unsigned", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    const r = await profileBrokerPolicy(proj);
    assert.equal(r.regime, "active");
    assert.equal(r.policy, null);
    assert.match(r.detail, /fail-closed/);
  });

  it("active + null policy when the profile was tampered after signing", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    writeFileSync(join(proj, PROFILE_FILE), SCOPED.replace("api.acme.com", "evil.com"));
    const r = await profileBrokerPolicy(proj);
    assert.equal(r.regime, "active");
    assert.equal(r.policy, null);
  });

  it("defaults fs to the project root when [scope].fs is omitted", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope]\negress = ["h.io"]\n`);
    await signProfile(proj);
    const r = await profileBrokerPolicy(proj);
    assert.equal(r.policy?.fs.root, resolve(proj, "."));
  });
});
