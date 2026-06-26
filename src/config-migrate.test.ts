import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA_VERSION } from "./config.js";
import {
  detectConfigVersion,
  planMigrations,
  migrateConfig,
  diffConfigs,
  MIGRATIONS,
} from "./config-migrate.js";

describe("detectConfigVersion", () => {
  it("treats an absent version field as legacy v0", () => {
    assert.equal(detectConfigVersion({ tools: { node: "22" } }), 0);
  });

  it("reads an explicit integer version", () => {
    assert.equal(detectConfigVersion({ version: 1 }), 1);
  });

  it("treats a non-integer / negative version as v0 (defensive)", () => {
    assert.equal(detectConfigVersion({ version: 1.5 }), 0);
    assert.equal(detectConfigVersion({ version: -3 }), 0);
    assert.equal(detectConfigVersion({ version: "1" as unknown as number }), 0);
  });
});

describe("planMigrations", () => {
  it("yields the v0->v1 step for (0, 1)", () => {
    const steps = planMigrations(0, 1);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].from, 0);
    assert.equal(steps[0].to, 1);
  });

  it("returns no steps when already at target", () => {
    assert.deepEqual(planMigrations(1, 1), []);
  });

  it("throws on a downgrade (config newer than this kit)", () => {
    assert.throws(() => planMigrations(2, 1), /newer than this kit/);
  });

  it("throws when no migration is registered for a gap", () => {
    assert.throws(() => planMigrations(0, 99), /No migration registered/);
  });

  it("registry rows are contiguous single steps", () => {
    for (const m of MIGRATIONS) {
      assert.equal(m.to, m.from + 1, `migration ${m.from}->${m.to} must be a single step`);
    }
  });
});

describe("migrateConfig", () => {
  it("stamps version and reports changed for a legacy config", () => {
    const input = { tools: { node: "22" } };
    const result = migrateConfig(input);
    assert.equal(result.fromVersion, 0);
    assert.equal(result.toVersion, CONFIG_SCHEMA_VERSION);
    assert.equal(result.changed, true);
    assert.equal(result.steps.length, 1);
    assert.equal((result.migrated as { version?: number }).version, 1);
    // Existing fields preserved.
    assert.deepEqual((result.migrated as { tools?: unknown }).tools, { node: "22" });
  });

  it("does not mutate the input object", () => {
    const input = { tools: { node: "22" } };
    migrateConfig(input);
    assert.equal("version" in input, false);
  });

  it("is a no-op when already at the current version", () => {
    const input = { version: 1, tools: { node: "22" } };
    const result = migrateConfig(input);
    assert.equal(result.changed, false);
    assert.deepEqual(result.steps, []);
  });
});

describe("diffConfigs", () => {
  it("reports the stamped version as an added path", () => {
    const before = { tools: { node: "22" } };
    const after = { version: 1, tools: { node: "22" } };
    const diff = diffConfigs(before, after);
    assert.equal(diff.length, 1);
    assert.equal(diff[0].path, "version");
    assert.equal(diff[0].before, undefined);
    assert.equal(diff[0].after, "1");
  });
});
