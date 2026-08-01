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

describe("isOneShot — fallback, precedence and fail-open edges", () => {
  it("prefers the composite operation:mode mapping over the bare operation", () => {
    // "migrate" alone is reusable; only the cross-vault mode is one-shot. If the
    // bare key ever won the lookup, a cross-vault migration would run under a
    // 15-min reusable elevation instead of consuming its marker.
    assert.equal(isOneShot("migrate"), false);
    assert.equal(isOneShot("migrate", "vault-to-vault"), true);
  });

  it("silently downgrades to the bare operation when the mode is unrecognised", () => {
    // Documented (and risky) behaviour: a typo'd mode does NOT throw and does NOT
    // inherit one-shot from a sibling mode — it falls back to bare "migrate",
    // which is reusable. A caller misspelling "vault-to-vault" loses the one-shot
    // guarantee without any signal.
    assert.equal(isOneShot("migrate", "vault-to-vaul"), false);
    assert.equal(isOneShot("rotate", "jwt-secret-rolll"), false);
  });

  it("does not prefix-match modes — an over-long mode falls back to the bare scope", () => {
    // "rotate:jwt-secret-roll:extra" is not a key, so the irreversible cutover
    // mapping is missed entirely and the reusable "rotate" mapping answers.
    assert.equal(isOneShot("rotate", "jwt-secret-roll:extra"), false);
  });

  it("treats an empty-string mode as no mode at all", () => {
    // `mode` is checked for truthiness, so "" skips composite lookup rather than
    // probing the nonexistent key "purge-history:".
    assert.equal(isOneShot("purge-history", ""), true);
    assert.equal(isOneShot("rotate", ""), false);
  });

  it("accepts a pre-joined operation:mode string as the operation", () => {
    // Callers that already hold the composite key still resolve to the one-shot
    // cutover mapping, because the bare-operation lookup hits the same key.
    assert.equal(isOneShot("rotate:jwt-secret-roll"), true);
    assert.equal(isOneShot("migrate:vault-to-vault"), true);
  });

  it("is case-sensitive and fails OPEN (non-one-shot) on a case-mismatched op", () => {
    // Security-relevant: an unmapped operation defaults to a reusable scope, so a
    // wrong-cased destructive op is gated less strictly, not more.
    assert.equal(isOneShot("PURGE-HISTORY"), false);
    assert.equal(isOneShot("Purge-History"), false);
  });

  it("returns false for unknown and empty operations", () => {
    assert.equal(isOneShot(""), false);
    assert.equal(isOneShot("nuke-everything"), false);
    assert.equal(isOneShot("nuke-everything", "hard"), false);
  });

  it("returns undefined (not false) for Object.prototype key names", () => {
    // Actual behaviour, asserted as-is: SCOPE_MAP is a plain object literal, so
    // SCOPE_MAP["toString"] resolves to the inherited function, passes the
    // truthiness check, and is returned as if it were a mapping — its .oneShot is
    // undefined. Callers doing `if (isOneShot(op))` still take the non-one-shot
    // branch, so this is not an escalation today, but it is not a real mapping.
    assert.equal(isOneShot("toString"), undefined);
    assert.equal(isOneShot("constructor"), undefined);
  });
});

describe("listScopes — invariants the CLI listing and the runtime gate share", () => {
  it("agrees with isOneShot for every key it advertises", () => {
    // `kit auth elevate --list-scopes` must not promise a one-shot status that the
    // runtime lookup would contradict; both read the same table, and this pins it.
    for (const m of listScopes()) {
      const idx = m.key.indexOf(":");
      const operation = idx === -1 ? m.key : m.key.slice(0, idx);
      const mode = idx === -1 ? undefined : m.key.slice(idx + 1);
      const label = `key "${m.key}" disagrees with isOneShot`;
      assert.equal(isOneShot(operation, mode), m.oneShot, label);
    }
  });

  it("never lets one scope name be both one-shot and reusable", () => {
    // This is the generalised form of the rotate/rotate-jwt-cutover regression: if
    // an irreversible op shared a scope string with a reversible one, a TTL
    // elevation minted for the benign op would authorize the destructive one.
    const oneShotByScope = new Map<string, boolean>();
    for (const m of listScopes()) {
      const prior = oneShotByScope.get(m.scope);
      if (prior === undefined) {
        oneShotByScope.set(m.scope, m.oneShot);
        continue;
      }
      const label = `scope "${m.scope}" is declared both one-shot and reusable`;
      assert.equal(m.oneShot, prior, label);
    }
  });

  it("keeps every known irreversible operation flagged one-shot", () => {
    // Lock-in: these four rewrite or invalidate state that cannot be restored, so
    // their elevation marker must be consumed on use.
    const byKey = new Map(listScopes().map((m) => [m.key, m] as const));
    for (const key of [
      "rotate:jwt-secret-roll",
      "migrate:vault-to-vault",
      "purge-history",
      "onecli-register",
    ]) {
      assert.equal(byKey.get(key)?.oneShot, true, `${key} must stay one-shot`);
    }
  });

  it("keeps additive/reversible operations off the one-shot path", () => {
    const byKey = new Map(listScopes().map((m) => [m.key, m] as const));
    const reusable = [
      "rotate:scoped-key-mint",
      "migrate:plaintext-to-vault",
      "propagate",
      "revoke-old",
    ];
    for (const key of reusable) {
      assert.equal(byKey.get(key)?.oneShot, false, `${key} must stay reusable`);
    }
  });

  it("lists each composite mode before its bare fallback", () => {
    // Ordering matters for the CLI listing: the specific modes should read above
    // the generic catch-all they override.
    const keys = listScopes().map((m) => m.key);
    assert.ok(keys.indexOf("rotate:jwt-secret-roll") < keys.indexOf("rotate"));
    assert.ok(keys.indexOf("rotate:scoped-key-mint") < keys.indexOf("rotate"));
    assert.ok(keys.indexOf("migrate:vault-to-vault") < keys.indexOf("migrate"));
  });

  it("returns a fresh array of copies, so a caller cannot mutate the table", () => {
    const first = listScopes();
    const second = listScopes();
    // Distinct arrays with equal contents — no shared array handed out.
    assert.notStrictEqual(first, second);
    assert.deepEqual(first, second);

    const purge = first.find((m) => m.key === "purge-history");
    assert.ok(purge);
    purge.oneShot = false;
    purge.scope = "hijacked";
    // Mutating what listScopes handed back must not disarm the real gate.
    assert.equal(isOneShot("purge-history"), true);
    assert.equal(listScopes().find((m) => m.key === "purge-history")?.oneShot, true);
    assert.equal(listScopes().find((m) => m.key === "purge-history")?.scope, "purge-history");
  });

  it("advertises no empty keys or empty scope names", () => {
    for (const m of listScopes()) {
      assert.ok(m.key.length > 0);
      assert.ok(m.scope.length > 0);
    }
  });
});
