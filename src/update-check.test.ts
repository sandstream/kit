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

  it("returns null under air-gap (KIT_AIRGAP) — no outbound npm beacon", async () => {
    // Clear the other suppressors so this proves the AIR-GAP branch specifically.
    const saved = {
      CI: process.env.CI,
      GH: process.env.GITHUB_ACTIONS,
      GL: process.env.GITLAB_CI,
      NO: process.env.KIT_NO_UPDATE_CHECK,
      AG: process.env.KIT_AIRGAP,
    };
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.KIT_NO_UPDATE_CHECK;
    process.env.KIT_AIRGAP = "1";
    try {
      assert.equal(await checkForUpdate("0.1.0"), null);
    } finally {
      for (const [k, v] of [
        ["CI", saved.CI],
        ["GITHUB_ACTIONS", saved.GH],
        ["GITLAB_CI", saved.GL],
        ["KIT_NO_UPDATE_CHECK", saved.NO],
        ["KIT_AIRGAP", saved.AG],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
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
