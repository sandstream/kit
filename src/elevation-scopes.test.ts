import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scopeFor, isOneShot, listScopes } from "./elevation-scopes.js";

describe("scopeFor", () => {
  it("matches composite operation:mode keys", () => {
    const m = scopeFor("rotate", "jwt-secret-roll");
    assert.equal(m.scope, "rotate-jwt-cutover");
    assert.equal(m.oneShot, true);
  });

  it("scoped-key-mint is NOT one-shot (reversible)", () => {
    const m = scopeFor("rotate", "scoped-key-mint");
    assert.equal(m.oneShot, false);
  });

  it("irreversible jwt cutover uses a DISTINCT scope from the reversible mint", () => {
    // Regression: sharing scope "rotate" let an elevation minted for the benign
    // scoped-key-mint authorize the irreversible jwt-secret-roll within its TTL.
    const cutover = scopeFor("rotate", "jwt-secret-roll");
    const mint = scopeFor("rotate", "scoped-key-mint");
    assert.notEqual(cutover.scope, mint.scope);
    assert.equal(mint.scope, "rotate");
    assert.equal(cutover.scope, "rotate-jwt-cutover");
  });

  it("falls back to bare operation when no mode given", () => {
    const m = scopeFor("rotate");
    assert.equal(m.scope, "rotate");
    assert.equal(m.oneShot, false);
  });

  it("vault-migrate is one-shot", () => {
    const m = scopeFor("migrate", "vault-to-vault");
    assert.equal(m.oneShot, true);
    assert.equal(m.scope, "vault-migrate");
  });

  it("purge-history is one-shot (irreversible)", () => {
    const m = scopeFor("purge-history");
    assert.equal(m.oneShot, true);
  });

  it("unknown op falls back to bare scope, non-one-shot", () => {
    const m = scopeFor("totally-new-op");
    assert.equal(m.scope, "totally-new-op");
    assert.equal(m.oneShot, false);
    assert.match(m.description, /Unmapped operation/);
  });
});

describe("isOneShot", () => {
  it("true for jwt-secret-roll", () => {
    assert.equal(isOneShot("rotate", "jwt-secret-roll"), true);
  });

  it("false for scoped-key-mint", () => {
    assert.equal(isOneShot("rotate", "scoped-key-mint"), false);
  });

  it("true for purge-history", () => {
    assert.equal(isOneShot("purge-history"), true);
  });
});

describe("listScopes", () => {
  it("returns every declared mapping with the key + description", () => {
    const all = listScopes();
    assert.ok(
      all.length >= 7,
      "covers all rotate modes + migrate + propagate + purge-history + onecli-register + revoke-old",
    );
    const keys = all.map((m) => m.key);
    assert.ok(keys.includes("rotate:jwt-secret-roll"));
    assert.ok(keys.includes("purge-history"));
    assert.ok(keys.includes("migrate:vault-to-vault"));
  });

  it("every entry has description + scope + oneShot fields", () => {
    for (const m of listScopes()) {
      assert.equal(typeof m.scope, "string");
      assert.equal(typeof m.oneShot, "boolean");
      assert.equal(typeof m.description, "string");
      assert.ok(m.description.length > 0);
    }
  });
});
