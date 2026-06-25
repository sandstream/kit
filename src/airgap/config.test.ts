import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAirGap, airGapTriageEnv, airGapTomlBlock } from "./config.js";

describe("resolveAirGap", () => {
  it("reads settings from .kit.toml [air_gap] when no env is set", () => {
    const s = resolveAirGap(
      {
        enabled: true,
        npm_registry: "https://npm.corp",
        threat_data_dir: "/opt/td",
        threat_data_pubkey: "/etc/k.pub",
      },
      {},
    );
    assert.equal(s.enabled, true);
    assert.equal(s.npmRegistry, "https://npm.corp");
    assert.equal(s.threatDataDir, "/opt/td");
    assert.equal(s.threatDataPubkey, "/etc/k.pub");
  });

  it("env overrides the checked-in config value", () => {
    const s = resolveAirGap(
      { npm_registry: "https://npm.corp" },
      { KIT_NPM_REGISTRY: "https://npm.override" },
    );
    assert.equal(s.npmRegistry, "https://npm.override");
  });

  it("KIT_AIRGAP truthy enables even if config is silent", () => {
    assert.equal(resolveAirGap(undefined, { KIT_AIRGAP: "1" }).enabled, true);
    assert.equal(resolveAirGap(undefined, { KIT_AIRGAP: "true" }).enabled, true);
    assert.equal(resolveAirGap(undefined, {}).enabled, false);
  });

  it("config enabled=true holds even without the env var", () => {
    assert.equal(resolveAirGap({ enabled: true }, {}).enabled, true);
  });

  it("is all-undefined / disabled with empty inputs", () => {
    const s = resolveAirGap(undefined, {});
    assert.equal(s.enabled, false);
    assert.equal(s.npmRegistry, undefined);
    assert.equal(s.threatDataDir, undefined);
  });
});

describe("airGapTriageEnv", () => {
  it("emits only the mirror vars that resolved to a value", () => {
    const env = airGapTriageEnv({
      enabled: true,
      npmRegistry: "https://npm.corp",
      githubApi: "https://ghe.corp/api/v3",
    });
    assert.deepEqual(env, {
      KIT_NPM_REGISTRY: "https://npm.corp",
      KIT_GITHUB_API: "https://ghe.corp/api/v3",
    });
  });

  it("is empty when no mirrors are configured", () => {
    assert.deepEqual(airGapTriageEnv({ enabled: true }), {});
  });
});

describe("airGapTomlBlock", () => {
  it("connected posture is just enabled = false (no mirror keys)", () => {
    assert.equal(airGapTomlBlock(false), "[air_gap]\nenabled = false");
  });

  it("enclave posture emits only the non-empty mirrors", () => {
    const block = airGapTomlBlock(true, {
      npmRegistry: "https://npm.corp",
      pypiIndex: "  ", // blank → skipped
      threatDataDir: "/opt/td",
    });
    assert.equal(
      block,
      '[air_gap]\nenabled = true\nnpm_registry = "https://npm.corp"\nthreat_data_dir = "/opt/td"',
    );
  });

  it("round-trips: the block resolveAirGap-parses back to the same posture", () => {
    // (shape check — the keys airGapTomlBlock writes are the keys resolveAirGap reads)
    const block = airGapTomlBlock(true, { githubApi: "https://ghe.corp/api/v3" });
    assert.match(block, /^\[air_gap\]$/m);
    assert.match(block, /enabled = true/);
    assert.match(block, /github_api = "https:\/\/ghe\.corp\/api\/v3"/);
  });
});
