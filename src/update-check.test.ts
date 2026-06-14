import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdate } from "./update-check.js";

describe("checkForUpdate", () => {
  it("returns null in CI environment", async () => {
    const orig = process.env.CI;
    process.env.CI = "true";
    try {
      const result = await checkForUpdate("0.1.0");
      assert.equal(result, null);
    } finally {
      if (orig === undefined) delete process.env.CI;
      else process.env.CI = orig;
    }
  });

  it("returns null when KIT_NO_UPDATE_CHECK=1", async () => {
    const orig = process.env.KIT_NO_UPDATE_CHECK;
    process.env.KIT_NO_UPDATE_CHECK = "1";
    try {
      const result = await checkForUpdate("0.1.0");
      assert.equal(result, null);
    } finally {
      if (orig === undefined) delete process.env.KIT_NO_UPDATE_CHECK;
      else process.env.KIT_NO_UPDATE_CHECK = orig;
    }
  });

  it("returns null in GITHUB_ACTIONS environment", async () => {
    const orig = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "true";
    try {
      const result = await checkForUpdate("0.1.0");
      assert.equal(result, null);
    } finally {
      if (orig === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = orig;
    }
  });

  it("never throws — handles network errors gracefully", async () => {
    const origCI = process.env.CI;
    const origNo = process.env.KIT_NO_UPDATE_CHECK;
    // Ensure not suppressed by CI flag but give a fake version that triggers fetch
    delete process.env.CI;
    delete process.env.KIT_NO_UPDATE_CHECK;
    try {
      // Pass a very high version so result would be null even if fetch succeeds
      const result = await checkForUpdate("999.999.999");
      // Should not throw; result is null or UpdateInfo
      assert(result === null || typeof result.available === "boolean");
    } finally {
      if (origCI === undefined) delete process.env.CI;
      else process.env.CI = origCI;
      if (origNo === undefined) delete process.env.KIT_NO_UPDATE_CHECK;
      else process.env.KIT_NO_UPDATE_CHECK = origNo;
    }
  });
});
