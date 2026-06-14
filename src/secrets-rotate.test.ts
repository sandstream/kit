import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateRandomToken, planRotation } from "./secrets-rotate.js";
import type { SecretsConfig } from "./config.js";

const baseConfig: SecretsConfig = {
  store: "1password",
  keys: {
    API_KEY: { source: "1password", ref: "op://Dev/Project/API_KEY" },
  },
};

describe("generateRandomToken", () => {
  it("returns base64url-safe characters at requested length", () => {
    const tok = generateRandomToken(32);
    // 32 bytes → 43 chars base64url, no padding, no slashes/plusses
    assert.equal(tok.length, 43);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(tok));
  });

  it("produces different values on each call", () => {
    assert.notEqual(generateRandomToken(), generateRandomToken());
  });
});

describe("planRotation", () => {
  it("errors when the key is not in the config", () => {
    const result = planRotation("MISSING", baseConfig, { random: true });
    assert.ok("error" in result);
  });

  it("errors when neither --value nor --random is provided", () => {
    const result = planRotation("API_KEY", baseConfig, {});
    assert.ok("error" in result);
    if ("error" in result) {
      assert.ok(result.error.includes("--value") || result.error.includes("--random"));
    }
  });

  it("accepts explicit --value", () => {
    const result = planRotation("API_KEY", baseConfig, { value: "new-secret-xyz" });
    assert.ok("plan" in result);
    if ("plan" in result) {
      assert.equal(result.plan.source, "explicit");
      assert.equal(result.value, "new-secret-xyz");
    }
  });

  it("accepts --random with default length", () => {
    const result = planRotation("API_KEY", baseConfig, { random: true });
    assert.ok("plan" in result);
    if ("plan" in result) {
      assert.equal(result.plan.source, "random");
      assert.equal(result.value.length, 43); // 32 bytes → 43 chars base64url
    }
  });

  it("accepts --random with explicit byte length", () => {
    const result = planRotation("API_KEY", baseConfig, { random: 64 });
    assert.ok("plan" in result);
    if ("plan" in result) {
      assert.equal(result.plan.source, "random");
      // 64 bytes → 86 chars base64url
      assert.equal(result.value.length, 86);
    }
  });

  it("rejects --random below 16 or above 256 bytes", () => {
    const tooSmall = planRotation("API_KEY", baseConfig, { random: 8 });
    assert.ok("error" in tooSmall);
    const tooBig = planRotation("API_KEY", baseConfig, { random: 1024 });
    assert.ok("error" in tooBig);
  });

  it("surfaces external-target hints in the plan", () => {
    const result = planRotation("API_KEY", baseConfig, { random: true });
    assert.ok("plan" in result);
    if ("plan" in result) {
      assert.ok(result.plan.externalTargets.length > 0);
      // Should mention the common platforms
      const joined = result.plan.externalTargets.join(" ");
      assert.ok(/Vercel|GitHub|CI/i.test(joined));
    }
  });
});
