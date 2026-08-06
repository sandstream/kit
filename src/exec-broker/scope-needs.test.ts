import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../identity.js";
import { PROFILE_FILE } from "../profile/schema.js";
import { signProfile } from "../profile/sign.js";
import { checkScopeNeeds } from "./scope-needs.js";
import { withGovernance } from "../governance-middleware.js";
import type { kitConfig, GovernanceConfig } from "../config.js";

let idDir: string;
let proj: string;
let savedIdEnv: string | undefined;
let savedCwd: string;

const SCOPED = `version = 1
[scope]
egress = ["api.acme.com"]
fs = ["src"]
secrets = ["DATABASE_URL"]
`;

// Governance enabled with safe test defaults (mirrors governance-middleware.test.ts):
// audit/revocation/expiry off, no approval prompts.
function makeConfig(govOverrides: Partial<GovernanceConfig> = {}): kitConfig {
  return {
    governance: {
      enabled: true,
      environment: "dev",
      audit: { enabled: false },
      revocation: { enabled: false },
      secrets: { check_expiration: false },
      approval: { destructive_operations: [], production_writes: false },
      ...govOverrides,
    },
  };
}

beforeEach(() => {
  idDir = mkdtempSync(join(tmpdir(), "kit-id-"));
  proj = mkdtempSync(join(tmpdir(), "kit-needs-"));
  savedIdEnv = process.env.KIT_IDENTITY_DIR;
  process.env.KIT_IDENTITY_DIR = idDir;
  savedCwd = process.cwd();
  process.chdir(proj);
  loadOrCreateIdentity();
});

afterEach(() => {
  process.chdir(savedCwd);
  if (savedIdEnv === undefined) delete process.env.KIT_IDENTITY_DIR;
  else process.env.KIT_IDENTITY_DIR = savedIdEnv;
  rmSync(idDir, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

async function signScoped(): Promise<void> {
  writeFileSync(join(proj, PROFILE_FILE), SCOPED);
  await signProfile(proj);
}

describe("checkScopeNeeds", () => {
  it("allows everything when no scope regime is declared (advisory floor unchanged)", async () => {
    assert.equal(await checkScopeNeeds({ egress: ["evil.com"] }, proj), null);
  });

  it("allows an empty declaration without consulting the scope", async () => {
    assert.equal(await checkScopeNeeds({}, proj), null);
    assert.equal(await checkScopeNeeds({ egress: [] }, proj), null);
  });

  it("denies declared needs when the scope is declared but unsigned (fail-closed)", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    const denial = await checkScopeNeeds({ egress: ["api.acme.com"] }, proj);
    assert.match(denial ?? "", /scope enforcement/);
    assert.match(denial ?? "", /fail-closed/);
  });

  it("grants in-scope needs and denies off-scope ones against a verified scope", async () => {
    await signScoped();
    assert.equal(
      await checkScopeNeeds(
        { egress: ["api.acme.com"], fsWrites: ["src/x.ts"], secrets: ["DATABASE_URL"] },
        proj,
      ),
      null,
    );
    assert.match(
      (await checkScopeNeeds({ egress: ["evil.com"] }, proj)) ?? "",
      /egress to evil\.com/,
    );
    assert.match(
      (await checkScopeNeeds({ fsWrites: ["secrets/creds"] }, proj)) ?? "",
      /write to secrets\/creds/,
    );
    assert.match(
      (await checkScopeNeeds({ secrets: ["AWS_SECRET"] }, proj)) ?? "",
      /secret\(s\) AWS_SECRET/,
    );
  });

  it("denies declared needs after the profile is tampered (fail-closed)", async () => {
    await signScoped();
    writeFileSync(join(proj, PROFILE_FILE), SCOPED.replace("api.acme.com", "evil.com"));
    assert.match(
      (await checkScopeNeeds({ egress: ["evil.com"] }, proj)) ?? "",
      /scope enforcement/,
    );
  });
});

describe("withGovernance + scopeNeeds (exec-broker proper)", () => {
  it("runs an operation whose declared needs are inside the verified scope", async () => {
    await signScoped();
    const result = await withGovernance(
      makeConfig(),
      {
        operation: "deploy",
        operationType: "write",
        scopeNeeds: { egress: ["api.acme.com"], secrets: ["DATABASE_URL"] },
      },
      async () => "ran",
    );
    assert.equal(result, "ran");
  });

  it("rejects (never executes) an operation with off-scope needs", async () => {
    await signScoped();
    let executed = false;
    await assert.rejects(
      withGovernance(
        makeConfig(),
        {
          operation: "exfil",
          operationType: "write",
          scopeNeeds: { egress: ["evil.com"] },
        },
        async () => {
          executed = true;
        },
      ),
      /scope enforcement/,
    );
    assert.equal(executed, false);
  });

  it("rejects declared needs when the scope regime is unsigned (fail-closed)", async () => {
    writeFileSync(join(proj, PROFILE_FILE), SCOPED);
    await assert.rejects(
      withGovernance(
        makeConfig(),
        { operation: "op", operationType: "write", scopeNeeds: { secrets: ["DATABASE_URL"] } },
        async () => "x",
      ),
      /scope enforcement/,
    );
  });

  it("checks scopeNeeds against opts.cwd, not process.cwd()", async () => {
    await signScoped();
    const caller = mkdtempSync(join(tmpdir(), "kit-needs-caller-"));
    try {
      process.chdir(caller);
      await assert.rejects(
        withGovernance(
          makeConfig(),
          {
            operation: "cross-project",
            operationType: "write",
            scopeNeeds: { egress: ["evil.com"] },
          },
          async () => "x",
          { cwd: proj },
        ),
        /scope enforcement/,
      );
    } finally {
      process.chdir(proj);
      rmSync(caller, { recursive: true, force: true });
    }
  });

  it("is backward compatible: no profile + no scopeNeeds ⇒ unchanged behavior", async () => {
    const result = await withGovernance(
      makeConfig(),
      { operation: "plain", operationType: "write" },
      async () => "ok",
    );
    assert.equal(result, "ok");
  });
});
