import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CUTOVER_NOTHING_TO_REVOKE,
  isSigningKeyMode,
  parseSupabaseMode,
  runSigningKeyRotation,
  signingKeyPolicyOps,
  signingKeyScope,
  type SigningKeyRotationDeps,
} from "./secrets-rotate-signing-key.js";
import { knownPolicyOps } from "./policy-gate.js";
import { scopeFor } from "./elevation-scopes.js";
import type { SigningKey } from "sandstream-kit-plugin-supabase";

const key = (id: string, status: SigningKey["status"]): SigningKey => ({
  id,
  algorithm: "ES256",
  status,
});

/** Fake deps that record every call in order; overrides change one behaviour per test. */
function fakeDeps(over: Partial<SigningKeyRotationDeps> = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const deps: SigningKeyRotationDeps = {
    listSigningKeys: async () => (calls.push("list"), [key("old", "in_use")]),
    rotateSigningKey: async () => (
      calls.push("rotate"),
      { activated: key("new", "in_use"), demoted: [key("old", "previously_used")] }
    ),
    revokeSigningKey: async (id) => (calls.push(`revoke:${id}`), key(id, "revoked")),
    elevate: async (scope, oneShot) => (
      calls.push(`elevate:${scope}:${oneShot}`),
      { ok: true, reason: "" }
    ),
    policyRefusal: async (op) => (calls.push(`policy:${op}`), undefined),
    log: (l) => out.push(l),
    err: (l) => out.push(l),
    ...over,
  };
  return { deps, calls, out };
}

describe("parseSupabaseMode", () => {
  it("accepts the three modes, passes undefined through, rejects the rest", () => {
    for (const m of [
      "scoped-key-mint",
      "jwt-secret-roll",
      "signing-key-rotate",
      "signing-key-cutover",
    ])
      assert.equal(
        parseSupabaseMode(m, () => {}),
        m,
      );
    assert.equal(
      parseSupabaseMode(undefined, () => {}),
      undefined,
    );
    const errs: string[] = [];
    assert.equal(
      parseSupabaseMode("signing-key", (l) => errs.push(l)),
      "invalid",
    );
    assert.match(errs[0]!, /signing-key-rotate/, "the error lists the valid modes");
  });

  it("routes exactly the two signing-key modes to this module", () => {
    assert.ok(isSigningKeyMode("signing-key-rotate"));
    assert.ok(isSigningKeyMode("signing-key-cutover"));
    for (const m of ["scoped-key-mint", "jwt-secret-roll", "invalid", undefined] as const)
      assert.equal(isSigningKeyMode(m), false);
  });
});

describe("signing-key elevation and policy", () => {
  it("revoking needs its own one-shot scope; rotating alone rides the reversible one", () => {
    const rotate = signingKeyScope(false);
    const revoke = signingKeyScope(true);
    assert.equal(rotate.scope, scopeFor("rotate", "scoped-key-mint").scope);
    assert.equal(rotate.oneShot, false);
    assert.equal(revoke.oneShot, true);
    assert.notEqual(revoke.scope, rotate.scope);
    assert.notEqual(revoke.scope, scopeFor("rotate", "jwt-secret-roll").scope);
  });

  it("checks only ops the policy registry knows", () => {
    for (const op of signingKeyPolicyOps(true)) assert.ok(knownPolicyOps().has(`supabase:${op}`));
    assert.deepEqual(signingKeyPolicyOps(false), ["signing_key_rotate"]);
  });
});

describe("runSigningKeyRotation: gates and order", () => {
  it("rotates after policy then elevation, and never revokes outside the cutover mode", async () => {
    const { deps, calls } = fakeDeps();
    assert.equal(await runSigningKeyRotation(deps, { revokePrevious: false, dryRun: false }), true);
    assert.deepEqual(calls, [
      "list",
      "policy:signing_key_rotate",
      "elevate:rotate:false",
      "rotate",
    ]);
  });

  it("cutover: both ops checked, one-shot elevation, every demoted key revoked", async () => {
    const { deps, calls } = fakeDeps();
    assert.equal(await runSigningKeyRotation(deps, { revokePrevious: true, dryRun: false }), true);
    assert.deepEqual(calls, [
      "list",
      "policy:signing_key_rotate",
      "policy:signing_key_revoke",
      `elevate:${signingKeyScope(true).scope}:true`,
      "rotate",
      "revoke:old",
    ]);
  });

  it("a policy refusal stops before elevation and before any vendor write", async () => {
    const { deps, calls } = fakeDeps({
      policyRefusal: async (op) => (op === "signing_key_revoke" ? "denied by repo" : undefined),
    });
    assert.equal(await runSigningKeyRotation(deps, { revokePrevious: true, dryRun: false }), false);
    assert.ok(!calls.some((c) => c === "rotate" || c.startsWith("elevate")));
  });

  it("a missing elevation stops before the vendor write", async () => {
    const { deps, calls } = fakeDeps({ elevate: async () => ({ ok: false, reason: "no marker" }) });
    assert.equal(
      await runSigningKeyRotation(deps, { revokePrevious: false, dryRun: false }),
      false,
    );
    assert.ok(!calls.includes("rotate"));
  });

  it("the revoke prompt defaults to no, and a no stops before rotating", async () => {
    let seenDefault: boolean | undefined;
    const { deps, calls } = fakeDeps({
      confirm: async (_q, _ms, defaultYes) => ((seenDefault = defaultYes), false),
    });
    assert.equal(await runSigningKeyRotation(deps, { revokePrevious: true, dryRun: false }), false);
    assert.equal(seenDefault, false);
    assert.ok(!calls.includes("rotate"));
  });
});

describe("runSigningKeyRotation: edge cases", () => {
  it("a cutover with no key in use refuses before anything, since it would revoke nothing", async () => {
    for (const dryRun of [false, true]) {
      const { deps, calls, out } = fakeDeps({
        listSigningKeys: async () => (calls.push("list"), [key("standby", "standby")]),
      });
      assert.equal(await runSigningKeyRotation(deps, { revokePrevious: true, dryRun }), false);
      assert.deepEqual(calls, ["list"]);
      assert.ok(out.some((l) => l.includes(CUTOVER_NOTHING_TO_REVOKE)));
    }
  });

  it("a plain rotate with no key in use still proceeds: nothing was promised to be revoked", async () => {
    const { deps, calls } = fakeDeps({ listSigningKeys: async () => (calls.push("list"), []) });
    assert.equal(await runSigningKeyRotation(deps, { revokePrevious: false, dryRun: false }), true);
    assert.ok(calls.includes("rotate"));
  });

  it("--dry-run reads the keys and changes nothing", async () => {
    const { deps, calls } = fakeDeps();
    assert.equal(await runSigningKeyRotation(deps, { revokePrevious: true, dryRun: true }), true);
    assert.deepEqual(calls, ["list"]);
  });

  it("a failed revoke is reported as a failure and names the key still verifying", async () => {
    const { deps, out } = fakeDeps({
      revokeSigningKey: async () => {
        throw new Error("revoke signing key old returned 500");
      },
    });
    assert.equal(await runSigningKeyRotation(deps, { revokePrevious: true, dryRun: false }), false);
    assert.ok(out.some((l) => /old still verifies until revoked/.test(l)));
  });

  it("without revoke, says the demoted key still verifies and how to revoke it", async () => {
    const { deps, out } = fakeDeps();
    await runSigningKeyRotation(deps, { revokePrevious: false, dryRun: false });
    assert.ok(out.some((l) => /--mode signing-key-cutover/.test(l)));
    assert.ok(out.some((l) => /No secret to store/.test(l)));
  });
});
