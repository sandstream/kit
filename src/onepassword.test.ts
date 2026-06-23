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
