import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { extractRbac, validateRbac, permissionMatches, type RbacPolicy } from "./policy-schema.js";
import {
  can,
  effectivePermissions,
  loadVerifiedPolicy,
  rbacPolicyRoot,
  type VerifiedPolicy,
} from "./resolve.js";
import {
  createGithubProvider,
  createGithubApiSource,
  compileRoleBindings,
  type GithubMembershipSource,
} from "./identity-provider.js";
import {
  loadOrCreateIdentity,
  signWithIdentity,
  recordRevocation,
  identityId,
} from "../identity.js";
import {
  loadPolicy,
  canonicalPolicyBytes,
  policyFingerprint,
  getPolicyPath,
  getPolicySigPath,
  type PolicyVerifyStatus,
} from "../policy-doc.js";

// A doc as smol-toml would parse `.kit-policy.toml` (the [rbac] table is a plain object).
function docWith(rbac: unknown): Record<string, unknown> {
  return { version: 1, require_triage: true, rbac };
}

// Build a VerifiedPolicy directly for pure-function tests, defaulting to a valid verdict.
function vp(doc: Record<string, unknown>, status: PolicyVerifyStatus = "valid"): VerifiedPolicy {
  return {
    root: "/x",
    doc: doc as never,
    rbac: extractRbac(doc),
    verify: { status, detail: "test" },
  };
}

const ROLES = {
  admin: ["*"],
  deployer: ["deploy:*", "secrets:read"],
  viewer: ["read:*"],
};

describe("rbac/policy-schema — validate + extract", () => {
  it("accepts a well-formed [rbac] table and normalizes it", () => {
    const doc = docWith({
      default_role: "viewer",
      roles: ROLES,
      bindings: [{ kid: "kid_a", role: "admin", label: "peter" }],
    });
    assert.deepEqual(validateRbac(doc), { ok: true, errors: [] });
    const rbac = extractRbac(doc) as RbacPolicy;
    assert.equal(rbac.defaultRole, "viewer");
    assert.deepEqual(rbac.roles.deployer, ["deploy:*", "secrets:read"]);
    assert.deepEqual(rbac.bindings[0], { kid: "kid_a", role: "admin", label: "peter" });
  });

  it("treats a doc with NO [rbac] table as valid but yields null (=> deny)", () => {
    assert.deepEqual(validateRbac({ version: 1 }), { ok: true, errors: [] });
    assert.equal(extractRbac({ version: 1 }), null);
  });

  it("fail-closed on malformed [rbac]: extract returns null, validate reports errors", () => {
    const badRoles = docWith({ roles: { admin: "not-an-array" }, bindings: [] });
    assert.equal(validateRbac(badRoles).ok, false);
    assert.equal(extractRbac(badRoles), null);

    const badBinding = docWith({ roles: ROLES, bindings: [{ role: "admin" }] }); // missing kid
    assert.match(validateRbac(badBinding).errors.join(), /kid.*non-empty string/);
    assert.equal(extractRbac(badBinding), null);

    const missingRoles = docWith({ bindings: [] });
    assert.match(validateRbac(missingRoles).errors.join(), /rbac\.roles.*required/);
    assert.equal(extractRbac(missingRoles), null);
  });

  it("rejects prototype-polluting keys in the rbac table", () => {
    const doc = docWith(JSON.parse('{"roles":{},"bindings":[],"__proto__":{"x":1}}'));
    assert.match(validateRbac(doc).errors.join(), /forbidden key/);
    assert.equal(extractRbac(doc), null);
  });

  it("permissionMatches: exact, domain prefix, and star", () => {
    assert.equal(permissionMatches("*", "anything:goes"), true);
    assert.equal(permissionMatches("secrets:*", "secrets:read"), true);
    assert.equal(permissionMatches("secrets:*", "deploy:prod"), false);
    assert.equal(permissionMatches("deploy:prod", "deploy:prod"), true);
    assert.equal(permissionMatches("deploy:prod", "deploy:staging"), false);
  });
});

describe("rbac/resolve — can() permission matching (offline, pure)", () => {
  const doc = docWith({
    roles: ROLES,
    bindings: [
      { kid: "kid_admin", role: "admin" },
      { kid: "kid_deployer", role: "deployer" },
    ],
  });

  it("grants a `*` role anything", () => {
    assert.equal(can("kid_admin", "deploy:prod", vp(doc)), true);
    assert.equal(can("kid_admin", "whatever:x", vp(doc)), true);
  });

  it("honors domain:* prefix but not across domains", () => {
    assert.equal(can("kid_deployer", "deploy:prod", vp(doc)), true);
    assert.equal(can("kid_deployer", "secrets:read", vp(doc)), true); // exact grant
    assert.equal(can("kid_deployer", "secrets:write", vp(doc)), false);
    assert.equal(can("kid_deployer", "read:anything", vp(doc)), false);
  });

  it("effectivePermissions unions grants for the subject's role(s)", () => {
    assert.deepEqual(effectivePermissions("kid_deployer", vp(doc)).sort(), [
      "deploy:*",
      "secrets:read",
    ]);
  });

  it("denies a subject whose role is absent from the roles table", () => {
    const d = docWith({ roles: ROLES, bindings: [{ kid: "kid_x", role: "ghost" }] });
    assert.equal(can("kid_x", "read:x", vp(d)), false);
    assert.deepEqual(effectivePermissions("kid_x", vp(d)), []);
  });

  it("unions permissions across MULTIPLE bindings for one kid", () => {
    const d = docWith({
      roles: ROLES,
      bindings: [
        { kid: "kid_multi", role: "deployer" },
        { kid: "kid_multi", role: "viewer" },
      ],
    });
    assert.equal(can("kid_multi", "deploy:prod", vp(d)), true);
    assert.equal(can("kid_multi", "read:logs", vp(d)), true);
  });
});

describe("rbac/resolve — fail-closed matrix (no false green)", () => {
  const doc = docWith({ roles: ROLES, bindings: [{ kid: "kid_admin", role: "admin" }] });

  it("allows ONLY when verify.status === valid", () => {
    assert.equal(can("kid_admin", "deploy:prod", vp(doc, "valid")), true);
    for (const status of [
      "unsigned",
      "unverifiable",
      "invalid",
      "revoked",
    ] as PolicyVerifyStatus[]) {
      assert.equal(
        can("kid_admin", "deploy:prod", vp(doc, status)),
        false,
        `status ${status} must deny`,
      );
      assert.deepEqual(effectivePermissions("kid_admin", vp(doc, status)), []);
    }
  });

  it("denies on a null policy", () => {
    assert.equal(can("kid_admin", "deploy:prod", null), false);
    assert.deepEqual(effectivePermissions("kid_admin", null), []);
  });

  it("denies an unknown subject with no defaultRole", () => {
    assert.equal(can("kid_nobody", "read:x", vp(doc)), false);
    assert.deepEqual(effectivePermissions("kid_nobody", vp(doc)), []);
  });

  it("grants an unknown subject the defaultRole's perms when set", () => {
    const d = docWith({ default_role: "viewer", roles: ROLES, bindings: [] });
    assert.equal(can("kid_nobody", "read:logs", vp(d)), true);
    assert.equal(can("kid_nobody", "deploy:prod", vp(d)), false);
  });

  it("denies when the [rbac] table is absent (rbac === null)", () => {
    const bare = vp({ version: 1 });
    assert.equal(bare.rbac, null);
    assert.equal(can("kid_admin", "read:x", bare), false);
  });

  it("ignores a binding whose pubkey does not derive to its kid", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const realPem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const realKid = identityId(realPem);

    // pubkey present but kid is WRONG => binding ignored => deny
    const mismatched = docWith({
      roles: ROLES,
      bindings: [{ kid: "kid_claimed_but_wrong", role: "admin", pubkey: realPem }],
    });
    assert.equal(can("kid_claimed_but_wrong", "deploy:prod", vp(mismatched)), false);

    // pubkey present AND kid derives correctly => honored => allow
    const consistent = docWith({
      roles: ROLES,
      bindings: [{ kid: realKid, role: "admin", pubkey: realPem }],
    });
    assert.equal(can(realKid, "deploy:prod", vp(consistent)), true);
  });
});

describe("rbac/resolve — rbacPolicyRoot override", () => {
  const prev = process.env.KIT_RBAC_POLICY;
  after(() => {
    if (prev === undefined) delete process.env.KIT_RBAC_POLICY;
    else process.env.KIT_RBAC_POLICY = prev;
  });

  it("KIT_RBAC_POLICY ?? override ?? cwd", () => {
    delete process.env.KIT_RBAC_POLICY;
    assert.equal(rbacPolicyRoot("/explicit"), "/explicit");
    assert.equal(rbacPolicyRoot(), process.cwd());
    process.env.KIT_RBAC_POLICY = "/env/root";
    assert.equal(rbacPolicyRoot("/explicit"), "/env/root"); // env wins
  });
});

describe("rbac/resolve — end-to-end signed policy + revocation + tamper", () => {
  let idDir: string;
  let subjectKid: string;
  const prev = process.env.KIT_IDENTITY_DIR;

  before(() => {
    idDir = mkdtempSync(join(tmpdir(), "kit-rbac-id-"));
    process.env.KIT_IDENTITY_DIR = idDir;
    loadOrCreateIdentity(); // the org/local signer, resolvable via localPublicKeys()
    const { publicKey } = generateKeyPairSync("ed25519");
    subjectKid = identityId(publicKey.export({ type: "spki", format: "pem" }) as string);
  });
  after(() => {
    if (prev === undefined) delete process.env.KIT_IDENTITY_DIR;
    else process.env.KIT_IDENTITY_DIR = prev;
    rmSync(idDir, { recursive: true, force: true });
  });

  function repo(): string {
    return mkdtempSync(join(tmpdir(), "kit-rbac-repo-"));
  }
  function writePolicyToml(root: string, bindKid: string): void {
    const toml = [
      "version = 1",
      "require_triage = true",
      "",
      "[rbac]",
      'default_role = "viewer"',
      "",
      "[rbac.roles]",
      'admin = ["*"]',
      'viewer = ["read:*"]',
      "",
      "[[rbac.bindings]]",
      `kid = "${bindKid}"`,
      'role = "admin"',
      "",
    ].join("\n");
    writeFileSync(getPolicyPath(root), toml);
  }
  function sign(root: string): void {
    const doc = loadPolicy(root);
    const { identity } = loadOrCreateIdentity();
    const rec = {
      kid: identity.id,
      sig: signWithIdentity(canonicalPolicyBytes(doc)).toString("base64"),
      ts: "t",
      fingerprint: policyFingerprint(doc),
    };
    writeFileSync(getPolicySigPath(root), JSON.stringify(rec));
  }

  it("loadVerifiedPolicy resolves valid and can() honors the signed bindings", () => {
    const root = repo();
    try {
      writePolicyToml(root, subjectKid);
      sign(root);
      const loaded = loadVerifiedPolicy(root);
      assert.ok(loaded, "policy should verify valid");
      assert.equal(loaded!.verify.status, "valid");
      assert.equal(can(subjectKid, "deploy:prod", loaded), true); // admin => *
      assert.equal(can("kid_stranger", "deploy:prod", loaded), false); // no binding
      assert.equal(can("kid_stranger", "read:logs", loaded), true); // defaultRole viewer
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a one-byte tamper flips verify to invalid => loadVerifiedPolicy null => deny", () => {
    const root = repo();
    try {
      writePolicyToml(root, subjectKid);
      sign(root);
      // Mutate the policy AFTER signing — signature no longer matches.
      const tampered = readFileSync(getPolicyPath(root), "utf8").replace(
        "require_triage = true",
        "require_triage = false",
      );
      writeFileSync(getPolicyPath(root), tampered);
      assert.equal(loadVerifiedPolicy(root), null);
      assert.equal(can(subjectKid, "deploy:prod", loadVerifiedPolicy(root)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a locally-revoked subject kid is denied despite a valid binding", () => {
    const root = repo();
    try {
      // A fresh subject key so revoking it can't bleed into other tests.
      const { publicKey } = generateKeyPairSync("ed25519");
      const revKid = identityId(publicKey.export({ type: "spki", format: "pem" }) as string);
      writePolicyToml(root, revKid);
      sign(root);
      const loaded = loadVerifiedPolicy(root);
      assert.equal(can(revKid, "deploy:prod", loaded), true); // before revocation
      recordRevocation(revKid, "compromised"); // into KIT_IDENTITY_DIR revocations.jsonl
      assert.equal(can(revKid, "deploy:prod", loaded), false); // secondary deny
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("rbac/identity-provider — enrollment compiles bindings offline", () => {
  it("maps teams -> roles, unions multi-group, reports unmapped, with NO network", async () => {
    let calls = 0;
    const source: GithubMembershipSource = {
      async listTeams(subject: string): Promise<string[]> {
        calls++;
        const table: Record<string, string[]> = {
          alice: ["platform-admins"],
          bob: ["deployers", "viewers"],
          carol: ["marketing"], // unmapped
        };
        return table[subject] ?? [];
      },
    };
    const provider = createGithubProvider({ source });
    const roleMap = {
      "platform-admins": "admin",
      deployers: "deployer",
      viewers: "viewer",
    };
    const result = await compileRoleBindings({
      provider,
      roleMap,
      subjects: [
        { subject: "alice", kid: "kid_alice" },
        { subject: "bob", kid: "kid_bob", label: "Bob" },
        { subject: "carol", kid: "kid_carol" },
      ],
    });

    assert.deepEqual(
      result.bindings.filter((b) => b.kid === "kid_alice"),
      [{ kid: "kid_alice", role: "admin" }],
    );
    // bob is in two mapped groups => two bindings (union of roles), label carried
    const bobRoles = result.bindings
      .filter((b) => b.kid === "kid_bob")
      .map((b) => b.role)
      .sort();
    assert.deepEqual(bobRoles, ["deployer", "viewer"]);
    assert.equal(result.bindings.find((b) => b.kid === "kid_bob")?.label, "Bob");
    // carol matched no mapped group => unmapped, no binding
    assert.equal(
      result.bindings.some((b) => b.kid === "kid_carol"),
      false,
    );
    assert.deepEqual(
      result.unmapped.map((s) => s.subject),
      ["carol"],
    );
    // membership was consulted, but the in-memory source touched no network.
    assert.equal(calls, 3);
  });

  it("namespaces groups by org and validates pubkey/kid consistency", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const kid = identityId(pem);
    const source: GithubMembershipSource = {
      async listTeams(): Promise<string[]> {
        return ["sec"];
      },
    };
    const provider = createGithubProvider({ source, org: "acme" });
    const roleMap = { "acme/sec": "admin" };

    const ok = await compileRoleBindings({
      provider,
      roleMap,
      subjects: [{ subject: "dana", kid, pubkey: pem }],
    });
    assert.deepEqual(ok.bindings, [{ kid, role: "admin", pubkey: pem }]);

    // a pubkey that does not derive to its kid must fail LOUD at enrollment
    await assert.rejects(
      compileRoleBindings({
        provider,
        roleMap,
        subjects: [{ subject: "dana", kid: "kid_wrong", pubkey: pem }],
      }),
      /derives to/,
    );
  });
});

describe("rbac/identity-provider — createGithubApiSource (fake fetch, no real network)", () => {
  const prev = process.env.KIT_RBAC_GITHUB_API;
  after(() => {
    if (prev === undefined) delete process.env.KIT_RBAC_GITHUB_API;
    else process.env.KIT_RBAC_GITHUB_API = prev;
  });

  it("hits the KIT_RBAC_GITHUB_API base with the bearer token and parses membership", async () => {
    process.env.KIT_RBAC_GITHUB_API = "https://ghe.example.com/api/v3";
    const seen: Array<{ url: string; auth: unknown }> = [];
    const fakeFetch = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url: String(url), auth: init.headers.Authorization });
      const u = String(url);
      if (u.endsWith("/orgs/acme/teams")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ slug: "deployers" }, { slug: "viewers" }],
        };
      }
      if (u.includes("/teams/deployers/memberships/octocat")) {
        return { ok: true, status: 200, json: async () => ({ state: "active" }) };
      }
      if (u.includes("/teams/viewers/memberships/octocat")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const src = createGithubApiSource({
      token: "test-token",
      org: "acme",
      fetchImpl: fakeFetch,
    });
    const teams = await src.listTeams("octocat");
    assert.deepEqual(teams, ["deployers"]); // only the active membership
    assert.ok(seen[0].url.startsWith("https://ghe.example.com/api/v3/orgs/acme/teams"));
    assert.equal(seen[0].auth, "Bearer test-token");
  });

  it("offline enrollment via an in-memory source calls fetch ZERO times", async () => {
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls++;
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;
    // Build an API source but DO NOT use it; enrollment uses an in-memory source.
    createGithubApiSource({ token: "x", org: "acme", fetchImpl: fakeFetch });
    const provider = createGithubProvider({
      source: {
        async listTeams() {
          return ["deployers"];
        },
      },
    });
    const result = await compileRoleBindings({
      provider,
      roleMap: { deployers: "deployer" },
      subjects: [{ subject: "eve", kid: "kid_eve" }],
    });
    assert.deepEqual(result.bindings, [{ kid: "kid_eve", role: "deployer" }]);
    assert.equal(fetchCalls, 0);
  });

  it("fail-closed: a non-OK teams-list response THROWS (never spurious empty membership)", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const src = createGithubApiSource({ token: "t", org: "acme", fetchImpl: fakeFetch });
    await assert.rejects(() => src.listTeams("octocat"), /teams list failed.*HTTP 403/);
  });

  it("fail-closed: a non-OK, non-404 membership response THROWS", async () => {
    const fakeFetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/orgs/acme/teams")) {
        return { ok: true, status: 200, json: async () => [{ slug: "deployers" }] };
      }
      // membership check returns 500 → must throw, not silently treat as non-member
      return { ok: false, status: 500, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const src = createGithubApiSource({ token: "t", org: "acme", fetchImpl: fakeFetch });
    await assert.rejects(() => src.listTeams("octocat"), /membership check failed.*HTTP 500/);
  });
});

describe("rbac architecture guard — resolve stays offline", () => {
  it("resolve.js imports neither identity-provider nor a network primitive", () => {
    const here = dirname(fileURLToPath(import.meta.url)); // dist/rbac
    const src = readFileSync(join(here, "resolve.js"), "utf8");
    assert.ok(
      !/from\s+["'][^"']*identity-provider/.test(src),
      "resolve.js must not import identity-provider",
    );
    assert.ok(
      !/from\s+["']node:(http|https|net|dns|tls)/.test(src),
      "resolve.js must not import a node network module",
    );
    assert.ok(!/\bfetch\s*\(/.test(src), "resolve.js must not call fetch");
  });
});
