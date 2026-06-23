import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveOneCliConfig, generatePlaceholder, checkOneCliStatus } from "./secrets-onecli.js";

describe("resolveOneCliConfig", () => {
  it("defaults to localhost when no env vars are set", () => {
    const prevApi = process.env.ONECLI_API_URL;
    const prevGw = process.env.ONECLI_GATEWAY_URL;
    const prevKey = process.env.ONECLI_API_KEY;
    delete process.env.ONECLI_API_URL;
    delete process.env.ONECLI_GATEWAY_URL;
    delete process.env.ONECLI_API_KEY;
    try {
      const cfg = resolveOneCliConfig();
      assert.equal(cfg.apiUrl, "http://127.0.0.1:10254");
      assert.equal(cfg.gatewayUrl, "http://127.0.0.1:10255");
      assert.equal(cfg.apiKey, undefined);
    } finally {
      if (prevApi !== undefined) process.env.ONECLI_API_URL = prevApi;
      if (prevGw !== undefined) process.env.ONECLI_GATEWAY_URL = prevGw;
      if (prevKey !== undefined) process.env.ONECLI_API_KEY = prevKey;
    }
  });

  it("honors env overrides", () => {
    process.env.ONECLI_API_URL = "https://onecli.internal";
    process.env.ONECLI_GATEWAY_URL = "https://gw.internal";
    process.env.ONECLI_API_KEY = "oc_test_xyz";
    try {
      const cfg = resolveOneCliConfig();
      assert.equal(cfg.apiUrl, "https://onecli.internal");
      assert.equal(cfg.gatewayUrl, "https://gw.internal");
      assert.equal(cfg.apiKey, "oc_test_xyz");
    } finally {
      delete process.env.ONECLI_API_URL;
      delete process.env.ONECLI_GATEWAY_URL;
      delete process.env.ONECLI_API_KEY;
    }
  });
});

describe("generatePlaceholder", () => {
  it("returns a PCLI_-prefixed base64url-ish token", () => {
    const tok = generatePlaceholder();
    assert.ok(tok.startsWith("PCLI_"));
    // 12 bytes → 16 base64url chars after "PCLI_"
    assert.equal(tok.length, "PCLI_".length + 16);
    assert.ok(/^PCLI_[A-Za-z0-9_-]+$/.test(tok));
  });

  it("produces distinct values per call", () => {
    assert.notEqual(generatePlaceholder(), generatePlaceholder());
  });
});

describe("checkOneCliStatus", () => {
  it("reports unreachable when no server runs at the URL", async () => {
    const status = await checkOneCliStatus({
      apiUrl: "http://127.0.0.1:1", // closed port — fails immediately
      gatewayUrl: "http://127.0.0.1:2",
      apiKey: undefined,
    });
    assert.equal(status.reachable, false);
    assert.equal(status.authenticated, false);
    assert.ok(status.error);
  });
});
