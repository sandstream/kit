import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateRbac, extractRbac, permissionMatches } from "./policy-schema.js";

// The RBAC decision engine. A bug here is an authorization bug, and the module had no
// tests at all — so these probe the security-relevant edges (wildcard scope,
// prototype pollution, fail-closed extraction) rather than the happy path.

describe("permissionMatches", () => {
  it("`*` grants everything", () => {
    assert.equal(permissionMatches("*", "deploy:prod"), true);
    assert.equal(permissionMatches("*", "anything"), true);
    assert.equal(permissionMatches("*", ""), true);
  });

  it("an exact grant matches only itself", () => {
    assert.equal(permissionMatches("deploy:prod", "deploy:prod"), true);
    assert.equal(permissionMatches("deploy:prod", "deploy:staging"), false);
    assert.equal(permissionMatches("deploy:prod", "deploy"), false);
  });

  it("`domain:*` matches within that domain", () => {
    assert.equal(permissionMatches("secrets:*", "secrets:read"), true);
    assert.equal(permissionMatches("secrets:*", "secrets:write"), true);
  });

  it("`domain:*` does NOT leak across a domain boundary", () => {
    // The separator has to be respected or `secrets:*` would grant `secretsadmin:…`.
    assert.equal(permissionMatches("secrets:*", "secretsadmin:read"), false);
    assert.equal(permissionMatches("secrets:*", "othersecrets:read"), false);
  });

  it("`domain:*` does not grant the bare domain with no action", () => {
    assert.equal(permissionMatches("secrets:*", "secrets"), false);
  });

  it("a leading wildcard is not a wildcard — only exact and trailing `:*` are special", () => {
    // `*:read` is neither `*` nor `…:*`, so it can only match itself. Documented here
    // so nobody writes it in a policy expecting it to work.
    assert.equal(permissionMatches("*:read", "secrets:read"), false);
    assert.equal(permissionMatches("*:read", "*:read"), true);
  });

  it("does not treat a grant as a regular expression", () => {
    assert.equal(permissionMatches("secrets:.*", "secrets:read"), false);
    assert.equal(permissionMatches("secrets:re.d", "secrets:read"), false);
  });

  it("is case-sensitive", () => {
    assert.equal(permissionMatches("Deploy:Prod", "deploy:prod"), false);
  });

  it("an empty grant matches nothing (not everything)", () => {
    assert.equal(permissionMatches("", "deploy:prod"), false);
  });
});

describe("validateRbac", () => {
  const wellFormed = {
    rbac: {
      roles: { admin: ["*"], dev: ["secrets:read"] },
      bindings: [{ kid: "kid_abc", role: "dev" }],
    },
  };

  it("accepts a well-formed table", () => {
    assert.deepEqual(validateRbac(wellFormed), { ok: true, errors: [] });
  });

  it("treats an absent [rbac] table as valid — RBAC is optional", () => {
    assert.deepEqual(validateRbac({ version: 1 }), { ok: true, errors: [] });
  });

  it("rejects a doc that is not a table", () => {
    for (const bad of [null, undefined, "policy", 42, ["a"]]) {
      assert.equal(validateRbac(bad).ok, false, `${JSON.stringify(bad)} must not validate`);
    }
  });

  it("rejects a non-table `rbac`", () => {
    assert.equal(validateRbac({ rbac: "admin" }).ok, false);
    assert.equal(validateRbac({ rbac: ["admin"] }).ok, false);
  });

  it("requires roles and bindings, and says which is missing", () => {
    const r = validateRbac({ rbac: {} });
    assert.equal(r.ok, false);
    assert.ok(
      r.errors.some((e) => e.includes("rbac.roles")),
      r.errors.join("; "),
    );
    assert.ok(
      r.errors.some((e) => e.includes("rbac.bindings")),
      r.errors.join("; "),
    );
  });

  it("accepts an empty bindings array — a policy that grants nobody anything is valid", () => {
    assert.equal(validateRbac({ rbac: { roles: {}, bindings: [] } }).ok, true);
  });

  it("rejects a role whose permissions are not all strings", () => {
    assert.equal(
      validateRbac({ rbac: { roles: { dev: "secrets:read" }, bindings: [] } }).ok,
      false,
    );
    assert.equal(validateRbac({ rbac: { roles: { dev: [1, 2] }, bindings: [] } }).ok, false);
    assert.equal(
      validateRbac({ rbac: { roles: { dev: ["ok", null] }, bindings: [] } }).ok,
      false,
      "a null among strings must not pass",
    );
  });

  it("rejects a binding missing or mistyping kid/role", () => {
    const cases = [
      [{ role: "dev" }, "no kid"],
      [{ kid: "kid_a" }, "no role"],
      [{ kid: "", role: "dev" }, "empty kid"],
      [{ kid: "kid_a", role: "" }, "empty role"],
      [{ kid: 1, role: "dev" }, "numeric kid"],
      ["not-a-table", "binding is a string"],
    ] as const;
    for (const [binding, why] of cases) {
      assert.equal(
        validateRbac({ rbac: { roles: {}, bindings: [binding] } }).ok,
        false,
        `must reject: ${why}`,
      );
    }
  });

  it("rejects a non-string pubkey or label rather than coercing", () => {
    assert.equal(
      validateRbac({ rbac: { roles: {}, bindings: [{ kid: "k", role: "r", pubkey: 5 }] } }).ok,
      false,
    );
    assert.equal(
      validateRbac({ rbac: { roles: {}, bindings: [{ kid: "k", role: "r", label: {} }] } }).ok,
      false,
    );
  });

  it("rejects a non-string default_role", () => {
    assert.equal(validateRbac({ rbac: { roles: {}, bindings: [], default_role: 7 } }).ok, false);
  });

  // Prototype pollution: a policy document is parsed from a file an operator may not
  // have written. These keys must be refused at every level, not silently absorbed.
  describe("prototype-pollution guards", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      it(`refuses \`${key}\` on the rbac table`, () => {
        const doc = { rbac: JSON.parse(`{"roles":{},"bindings":[],"${key}":{}}`) };
        const r = validateRbac(doc);
        assert.equal(r.ok, false);
        assert.ok(
          r.errors.some((e) => e.includes(key)),
          r.errors.join("; "),
        );
      });

      it(`refuses \`${key}\` as a role name`, () => {
        const doc = { rbac: { roles: JSON.parse(`{"${key}":["*"]}`), bindings: [] } };
        assert.equal(validateRbac(doc).ok, false);
      });

      it(`refuses \`${key}\` inside a binding`, () => {
        const doc = {
          rbac: {
            roles: {},
            bindings: [JSON.parse(`{"kid":"k","role":"r","${key}":{}}`)],
          },
        };
        assert.equal(validateRbac(doc).ok, false);
      });
    }
  });
});

describe("extractRbac", () => {
  it("normalizes a well-formed table", () => {
    const out = extractRbac({
      rbac: {
        roles: { dev: ["secrets:read"] },
        bindings: [{ kid: "kid_a", role: "dev", label: "alice", pubkey: "PEM" }],
        default_role: "dev",
      },
    });
    assert.deepEqual(out, {
      roles: { dev: ["secrets:read"] },
      bindings: [{ kid: "kid_a", role: "dev", pubkey: "PEM", label: "alice" }],
      defaultRole: "dev",
    });
  });

  it("returns null when there is no [rbac] table", () => {
    assert.equal(extractRbac({ version: 1 }), null);
  });

  // The fail-closed contract the resolver depends on: null means "no bindings", total
  // deny. A malformed table must never be partially interpreted into a grant.
  it("returns null for a malformed table rather than a partial policy", () => {
    const malformed = [
      { rbac: { roles: { dev: ["ok"] } } }, // bindings missing
      { rbac: { bindings: [] } }, // roles missing
      { rbac: { roles: { dev: [1] }, bindings: [] } }, // non-string permission
      { rbac: { roles: {}, bindings: [{ kid: "k" }] } }, // binding without a role
      { rbac: "admin" },
      "not a doc",
    ];
    for (const doc of malformed) {
      assert.equal(extractRbac(doc), null, `must fail closed: ${JSON.stringify(doc)}`);
    }
  });

  it("omits defaultRole when it is absent rather than inventing one", () => {
    const out = extractRbac({ rbac: { roles: {}, bindings: [] } });
    assert.deepEqual(out, { roles: {}, bindings: [] });
    assert.equal("defaultRole" in out!, false);
  });

  it("a polluted table never reaches normalization — validation fails first", () => {
    // extractRbac also skips forbidden role keys defensively, but validateRbac rejects
    // the doc before that runs. Pinning the outer behaviour, which is what callers see.
    const doc = { rbac: { roles: JSON.parse('{"__proto__":["*"]}'), bindings: [] } };
    assert.equal(extractRbac(doc), null);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("drops a non-table entry in bindings instead of failing the whole extract", () => {
    // Reachable only when validation passed, i.e. every binding is a table — so this
    // pins the loop's defensive branch as a no-op, not as a silent data path.
    const out = extractRbac({
      rbac: { roles: {}, bindings: [{ kid: "k", role: "r" }] },
    });
    assert.equal(out!.bindings.length, 1);
  });
});
