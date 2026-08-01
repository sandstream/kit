import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { check1PasswordStatus, validate1PasswordRef, generate1PasswordRef } from "./onepassword.js";

describe("onepassword", () => {
  describe("validate1PasswordRef", () => {
    it("accepts valid op:// references", () => {
      assert.ok(validate1PasswordRef("op://vault/item"));
      assert.ok(validate1PasswordRef("op://vault/item/field"));
      assert.ok(validate1PasswordRef("op://Dev/Stripe/key"));
      assert.ok(validate1PasswordRef("op://Private/GitHub/personal-token"));
    });

    it("rejects invalid references", () => {
      assert.ok(!validate1PasswordRef("vault/item"));
      assert.ok(!validate1PasswordRef("op://vault"));
      assert.ok(!validate1PasswordRef("1password://vault/item"));
      assert.ok(!validate1PasswordRef(""));
    });
  });

  describe("generate1PasswordRef", () => {
    it("generates refs without field", () => {
      const ref = generate1PasswordRef("vault", "item");
      assert.equal(ref, "op://vault/item");
    });

    it("generates refs with field", () => {
      const ref = generate1PasswordRef("vault", "item", "field");
      assert.equal(ref, "op://vault/item/field");
    });

    it("handles real-world vault/item names", () => {
      const ref = generate1PasswordRef("Dev", "Stripe", "secret-key");
      assert.equal(ref, "op://Dev/Stripe/secret-key");
    });
  });

  describe("check1PasswordStatus", () => {
    it("detects when op CLI is not installed", async () => {
      // This test will fail if op is actually installed
      // In CI environments, op may be installed, so we skip
      if (process.env.CI) {
        return; // Skip in CI
      }

      const status = await check1PasswordStatus();
      assert.ok(!status.installed || !status.authenticated);
    });
  });
});

describe("validate1PasswordRef — boundaries and malformed input", () => {
  it("rejects a trailing slash when no field is given but accepts one after a field", () => {
    // Asymmetry in the pattern: the optional field group is `(\/.+)?`, so a bare
    // trailing separator has nothing to consume it, while a field segment happily
    // swallows the trailing slash as part of the field name. Pinning both halves
    // so a "tidy up the regex" refactor cannot silently flip either one.
    assert.equal(validate1PasswordRef("op://vault/item/"), false);
    assert.equal(validate1PasswordRef("op://vault/item/field/"), true);
  });

  it("requires both the vault and the item segment to be non-empty", () => {
    // An empty segment means the ref cannot address anything; these must stay denied
    // or callers would hand `op read` a ref that resolves to the wrong scope.
    assert.equal(validate1PasswordRef("op:///item"), false);
    assert.equal(validate1PasswordRef("op://vault//field"), false);
    assert.equal(validate1PasswordRef("op:///"), false);
    assert.equal(validate1PasswordRef("op://"), false);
  });

  it("accepts more path segments than vault/item/field", () => {
    // The field group is `.+`, not a single segment, so section-qualified refs
    // (op://vault/item/section/field) validate. This is deliberate — 1Password
    // itself supports them — so a stricter three-segment rule would be a regression.
    assert.equal(validate1PasswordRef("op://vault/item/section/field"), true);
    assert.equal(validate1PasswordRef("op://vault/item/a/b/c/d"), true);
  });

  it("is case-sensitive about the scheme and rejects near-miss prefixes", () => {
    assert.equal(validate1PasswordRef("OP://vault/item"), false);
    assert.equal(validate1PasswordRef("Op://vault/item"), false);
    assert.equal(validate1PasswordRef("op:/vault/item"), false);
    // Anchored at both ends, so no substring match can smuggle a ref through.
    assert.equal(validate1PasswordRef("xop://vault/item"), false);
    assert.equal(validate1PasswordRef(" op://vault/item"), false);
  });

  it("tolerates embedded newlines in vault and item but not in the field", () => {
    // Documented as-is, NOT as desired: `[^/]+` excludes only "/" so it matches
    // newlines, while the field group's "." does not. A ref carrying a newline is a
    // plausible injection vector into anything that line-splits op output, so if this
    // is ever tightened, tighten vault/item too — do not just delete these asserts.
    assert.equal(validate1PasswordRef("op://va\nult/item"), true);
    assert.equal(validate1PasswordRef("op://vault/it\nem"), true);
    assert.equal(validate1PasswordRef("op://vault/item\n"), true);
    assert.equal(validate1PasswordRef("op://vault/item/fi\nld"), false);
  });

  it("does not interpret traversal or query syntax — validation is purely structural", () => {
    // This is a shape check, not a safety check. Callers must not treat a `true`
    // here as "this ref is safe to interpolate"; these stay true to make that explicit.
    assert.equal(validate1PasswordRef("op://v/i/../../etc/passwd"), true);
    assert.equal(validate1PasswordRef("op://vault/item?x=1"), true);
    assert.equal(validate1PasswordRef("op://My Vault/My Item/password"), true);
  });

  it("rejects whitespace-only and non-ref strings", () => {
    assert.equal(validate1PasswordRef("   "), false);
    assert.equal(validate1PasswordRef("op://vault item"), false);
    assert.equal(validate1PasswordRef("https://vault/item"), false);
  });
});

describe("generate1PasswordRef — field handling and round-trip", () => {
  it("treats an empty-string field as no field at all", () => {
    // The guard is `if (field)`, so "" is falsy and the field is dropped rather than
    // producing the "op://v/i/" form that validate1PasswordRef would reject.
    // Callers passing a field read out of config must therefore check for "" themselves.
    assert.equal(generate1PasswordRef("vault", "item", ""), "op://vault/item");
  });

  it("keeps a field whose name is the string zero — only the empty string is dropped", () => {
    // Guards against someone "fixing" the falsy check into a length/number test.
    assert.equal(generate1PasswordRef("vault", "item", "0"), "op://vault/item/0");
  });

  it("emits whatever it is given without escaping separators", () => {
    // No escaping and no validation: a slash in any argument silently changes the
    // ref's shape. A vault literally named "a/b" produces a ref addressing a
    // different item. Worth knowing before wiring this to user input.
    assert.equal(generate1PasswordRef("a/b", "item"), "op://a/b/item");
    assert.equal(generate1PasswordRef("vault", "item", "sec/field"), "op://vault/item/sec/field");
  });

  it("does not trim or reject whitespace and newlines in its arguments", () => {
    assert.equal(generate1PasswordRef(" vault ", "item"), "op:// vault /item");
    assert.equal(generate1PasswordRef("va\nult", "item"), "op://va\nult/item");
  });

  it("can produce a ref that validate1PasswordRef rejects", () => {
    // The generator performs no validation, so the pair is NOT closed: empty
    // arguments yield a structurally invalid ref. Anything building a ref from
    // user or config input must validate the result, not assume it.
    const bad = generate1PasswordRef("", "");
    assert.equal(bad, "op:///");
    assert.equal(validate1PasswordRef(bad), false);
  });

  it("round-trips through the validator for well-formed arguments", () => {
    for (const ref of [
      generate1PasswordRef("Dev", "Stripe"),
      generate1PasswordRef("Dev", "Stripe", "secret-key"),
      generate1PasswordRef("My Vault", "My Item", "password"),
    ]) {
      assert.equal(validate1PasswordRef(ref), true, `expected ${JSON.stringify(ref)} to validate`);
    }
  });
});
