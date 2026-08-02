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

  it("enforceRuntime is false unless the scope opts in", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    assert.equal((await profileBrokerPolicy(proj)).enforceRuntime, false);
  });

  it("enforceRuntime reflects [scope].enforce_runtime — even before signing (opt-in is the declaration)", async () => {
    const body = `version = 1\n[scope]\negress = ["api.acme.com"]\nenforce_runtime = true\n`;
    writeFileSync(join(proj, PROFILE_FILE), body);
    // Unsigned: opted in, but policy is null (fail-closed) — the runtime default-denies declared ops.
    const unsigned = await profileBrokerPolicy(proj);
    assert.equal(unsigned.enforceRuntime, true);
    assert.equal(unsigned.policy, null);
    // Signed: opted in AND a governing policy is present.
    await signProfile(proj);
    const signed = await profileBrokerPolicy(proj);
    assert.equal(signed.enforceRuntime, true);
    assert.deepEqual(signed.policy?.egress.allow, ["api.acme.com"]);
  });

  it("signHosts is effective only when the scope verifies; declared list is always surfaced", async () => {
    const body = `version = 1\n[scope]\negress = ["api.acme.com"]\nsign = ["api.acme.com", ".internal.io"]\n`;
    writeFileSync(join(proj, PROFILE_FILE), body);
    // Unsigned: declared list is surfaced, but the EFFECTIVE list is empty (fail-closed).
    const unsigned = await profileBrokerPolicy(proj);
    assert.deepEqual(unsigned.signHostsDeclared, ["api.acme.com", ".internal.io"]);
    assert.deepEqual(unsigned.signHosts, []);
    // Signed: the declared list becomes effective.
    await signProfile(proj);
    const signed = await profileBrokerPolicy(proj);
    assert.deepEqual(signed.signHosts, ["api.acme.com", ".internal.io"]);
  });

  it("signHosts is empty when no [scope].sign is declared", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await signProfile(proj);
    const r = await profileBrokerPolicy(proj);
    assert.deepEqual(r.signHostsDeclared, []);
    assert.deepEqual(r.signHosts, []);
  });

  it("runtimeMode reflects the enforce_runtime declaration (off / observe / enforce)", async () => {
    // off — no scope
    assert.equal((await profileBrokerPolicy(proj)).runtimeMode, "off");
    // observe
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope]\nenforce_runtime = "observe"\n`);
    await signProfile(proj);
    const obs = await profileBrokerPolicy(proj);
    assert.equal(obs.runtimeMode, "observe");
    assert.equal(obs.enforceRuntime, false, "observe is not enforce");
    // enforce
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope]\nenforce_runtime = true\n`);
    await signProfile(proj);
    const enf = await profileBrokerPolicy(proj);
    assert.equal(enf.runtimeMode, "enforce");
    assert.equal(enf.enforceRuntime, true);
  });

  it("runtimeMode is read from the declaration even before signing", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope]\nenforce_runtime = "observe"\n`);
    const r = await profileBrokerPolicy(proj); // unsigned
    assert.equal(r.runtimeMode, "observe");
    assert.equal(r.policy, null, "unsigned → null policy (observe still reports would-denies)");
  });

  it("DEFAULT-ON: a declared scope with no enforce_runtime defaults to observe", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope]\negress = ["h.io"]\n`);
    await signProfile(proj);
    const r = await profileBrokerPolicy(proj);
    assert.equal(
      r.runtimeMode,
      "observe",
      "mediation is on (dry-run) by default for a declared scope",
    );
    assert.equal(r.enforceRuntime, false, "default-on is observe, not enforce");
  });

  it("enforce_runtime = false is an explicit opt-out (runtimeMode off)", async () => {
    writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope]\nenforce_runtime = false\n`);
    await signProfile(proj);
    assert.equal((await profileBrokerPolicy(proj)).runtimeMode, "off");
  });

  // An UNREADABLE profile used to return runtimeMode "off". Because runBrokered skips the broker
  // entirely on "off", corrupting the TOML achieved what tampering with the signature cannot:
  // mediation switched itself off and the op ran unmediated. These pin the closed door.
  describe("an unreadable profile default-denies instead of dropping to unmediated", () => {
    const BROKEN = [
      ["unparseable TOML", `version = 1\n[scope\negress = [`],
      ["missing schema version", `[scope]\negress = ["api.acme.com"]\n`],
      ["unknown key (strict schema)", `version = 1\n[scope]\nnot_a_field = 1\n`],
      ["wrong type for enforce_runtime", `version = 1\n[scope]\nenforce_runtime = "yes"\n`],
    ] as const;

    for (const [label, body] of BROKEN) {
      it(`${label} → runtimeMode enforce with a null policy`, async () => {
        writeFileSync(join(proj, PROFILE_FILE), body);
        const r = await profileBrokerPolicy(proj);
        assert.equal(r.runtimeMode, "enforce", "must NOT be 'off' — that is the fail-open");
        assert.equal(r.enforceRuntime, true);
        assert.equal(r.policy, null, "no readable scope grants nothing");
        assert.equal(r.regime, "active");
        assert.match(r.detail, /profile unreadable/);
      });
    }

    it("signing a broken profile does not rescue it (the bytes still do not parse)", async () => {
      writeFileSync(join(proj, PROFILE_FILE), `version = 1\n[scope\n`);
      await assert.rejects(() => signProfile(proj));
      const r = await profileBrokerPolicy(proj);
      assert.equal(r.runtimeMode, "enforce");
      assert.equal(r.policy, null);
    });
  });

  it("enforceRuntime always equals runtimeMode === 'enforce' (the documented equivalence)", async () => {
    const cases = [
      null, // no profile
      `version = 1\nname = "x"\n`, // no [scope]
      `version = 1\n[scope]\negress = ["h.io"]\n`, // default-on → observe
      `version = 1\n[scope]\nenforce_runtime = "observe"\n`,
      `version = 1\n[scope]\nenforce_runtime = false\n`,
      `version = 1\n[scope]\nenforce_runtime = true\n`,
      `version = 1\n[scope\n`, // unreadable
    ];
    for (const body of cases) {
      rmSync(join(proj, PROFILE_FILE), { force: true });
      if (body !== null) writeFileSync(join(proj, PROFILE_FILE), body);
      const r = await profileBrokerPolicy(proj);
      assert.equal(
        r.enforceRuntime,
        r.runtimeMode === "enforce",
        `${JSON.stringify(body)} → mode ${r.runtimeMode} but enforceRuntime ${r.enforceRuntime}`,
      );
    }
  });
});
