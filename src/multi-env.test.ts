import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeEnvironmentConfig } from "./config.js";
import type { kitConfig, EnvOverride } from "./config.js";

describe("mergeEnvironmentConfig", () => {
  const base: kitConfig = {
    tools: { node: "22", pnpm: "latest" },
    secrets: { store: "1password", template: ".env.template" },
    services: { supabase: { login: "supabase login", check: "supabase projects list" } },
  };

  it("returns base config when override is empty", () => {
    const result = mergeEnvironmentConfig(base, {});
    assert.deepEqual(result.tools, base.tools);
    assert.deepEqual(result.secrets, base.secrets);
    assert.deepEqual(result.services, base.services);
  });

  it("overrides secrets.store with env-specific value", () => {
    const override: EnvOverride = { secrets: { store: "doppler" } };
    const result = mergeEnvironmentConfig(base, override);
    assert.equal(result.secrets?.store, "doppler");
    assert.equal(result.tools?.node, "22"); // base tools preserved
  });

  it("merges services rather than replacing", () => {
    const override: EnvOverride = {
      services: { stripe: { login: "stripe login", check: "stripe config --list" } },
    };
    const result = mergeEnvironmentConfig(base, override);
    assert(result.services?.supabase !== undefined, "base service preserved");
    assert(result.services?.stripe !== undefined, "override service added");
  });

  it("overrides tools completely when specified", () => {
    const override: EnvOverride = { tools: { node: "20" } };
    const result = mergeEnvironmentConfig(base, override);
    assert.equal(result.tools?.node, "20");
    assert.equal(result.tools?.pnpm, undefined); // override replaces, not merges
  });

  it("preserves hooks and web from base (not in override interface)", () => {
    const baseWithHooks: kitConfig = {
      ...base,
      hooks: { "pre-commit": ["npm test"] },
    };
    const result = mergeEnvironmentConfig(baseWithHooks, {});
    assert.deepEqual(result.hooks, { "pre-commit": ["npm test"] });
  });
});
