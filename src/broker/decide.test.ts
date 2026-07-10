import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../identity.js";
import { PROFILE_FILE } from "../profile/schema.js";
import { signProfile } from "../profile/sign.js";
import { brokerStatus, brokerScope } from "./decide.js";

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
  proj = mkdtempSync(join(tmpdir(), "kit-broker-"));
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

describe("brokerStatus", () => {
  it("reports none when no profile is declared", async () => {
    const st = await brokerStatus(proj);
    assert.equal(st.state, "none");
    assert.equal(st.scope, null);
  });

  it("reports none when the profile declares no [scope]", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\nname = "no-scope"\n`);
    const st = await brokerStatus(proj);
    assert.equal(st.state, "none");
    assert.match(st.detail, /no \[scope\]/);
  });

  it("reports unsigned (grants nothing) for a declared-but-unsigned scope", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    const st = await brokerStatus(proj);
    assert.equal(st.state, "unsigned");
    assert.equal(st.scope, null);
    assert.match(st.detail, /fail-closed/);
  });

  it("reports verified with the governing scope for a signed profile", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    const st = await brokerStatus(proj);
    assert.equal(st.state, "verified");
    assert.deepEqual(st.scope?.egress, ["api.acme.com"]);
    assert.match(st.detail, /1 egress host/);
  });

  it("reports invalid (grants nothing) when the profile was tampered after signing", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    writeFileSync(join(proj, PROFILE_FILE), SCOPED.replace("api.acme.com", "evil.example.com"));
    const st = await brokerStatus(proj);
    assert.equal(st.state, "invalid");
    assert.equal(st.scope, null);
  });

  it("reports invalid (never throws) on a malformed profile", async () => {
    writeFileSync(join(proj, PROFILE_FILE), "not = = toml");
    const st = await brokerStatus(proj);
    assert.equal(st.state, "invalid");
    assert.match(st.detail, /unreadable/);
  });
});

describe("brokerScope (fail-closed)", () => {
  it("returns the scope only for a verified signature", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    const scope = await brokerScope(proj);
    assert.deepEqual(scope?.secrets, ["DATABASE_URL"]);
  });

  it("returns null for unsigned, tampered, malformed, and absent profiles", async () => {
    assert.equal(await brokerScope(proj), null); // absent

    writeFileSync(join(proj, PROFILE_FILE), SCOPED); // unsigned
    assert.equal(await brokerScope(proj), null);

    await signProfile(proj); // tampered after signing
    writeFileSync(join(proj, PROFILE_FILE), SCOPED.replace("acme", "evil"));
    assert.equal(await brokerScope(proj), null);

    writeFileSync(join(proj, PROFILE_FILE), "not = = toml"); // malformed — never throws
    assert.equal(await brokerScope(proj), null);
  });
});
