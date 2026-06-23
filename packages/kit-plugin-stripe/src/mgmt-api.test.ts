import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeClient, detectMode, listWebhookEndpoints, assertModeForUrl } from "./mgmt-api.js";

describe("makeClient", () => {
  it("throws when STRIPE_SECRET_KEY is missing", () => {
    const prev = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    try {
      assert.throws(() => makeClient(), /STRIPE_SECRET_KEY/);
    } finally {
      if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev;
    }
  });

  it("detects test vs live vs restricted vs unknown modes", () => {
    assert.equal(detectMode("sk_test_abc"), "test");
    assert.equal(detectMode("sk_live_abc"), "live");
    assert.equal(detectMode("rk_test_abc"), "restricted");
    assert.equal(detectMode("rk_live_abc"), "restricted");
    assert.equal(detectMode("garbage"), "unknown");
  });

  it("pins the Stripe API version + User-Agent", () => {
    const client = makeClient({ secretKey: "sk_test_x" });
    const h = client.headers as Record<string, string>;
    assert.equal(h["Stripe-Version"], "2024-12-18.acacia");
    assert.equal(h["User-Agent"], "sandstream-kit-plugin-stripe");
    assert.equal(client.mode, "test");
  });
});

describe("assertModeForUrl", () => {
  it("refuses live key against localhost URL", () => {
    const client = makeClient({ secretKey: "sk_live_x" });
    assert.throws(
      () => assertModeForUrl(client, "https://localhost:3000/webhook"),
      /LIVE-mode webhook against test-looking URL/,
    );
  });

  it("refuses live key against 127.0.0.1 URL", () => {
    const client = makeClient({ secretKey: "sk_live_x" });
    assert.throws(() => assertModeForUrl(client, "http://127.0.0.1:8080/cb"), /LIVE-mode/);
  });

  it("refuses test key against http:// URL (signature downgrade)", () => {
    const client = makeClient({ secretKey: "sk_test_x" });
    assert.throws(() => assertModeForUrl(client, "http://example.com/webhook"), /non-HTTPS URL/);
  });

  it("allows live key against https://example.com", () => {
    const client = makeClient({ secretKey: "sk_live_x" });
    assert.doesNotThrow(() => assertModeForUrl(client, "https://example.com/webhook"));
  });

  it("allows test key against https://localhost", () => {
    const client = makeClient({ secretKey: "sk_test_x" });
    assert.doesNotThrow(() => assertModeForUrl(client, "https://localhost:3000/webhook"));
  });

  it("force=true overrides the refusal", () => {
    const client = makeClient({ secretKey: "sk_live_x" });
    assert.doesNotThrow(() =>
      assertModeForUrl(client, "https://localhost:3000/webhook", { force: true }),
    );
  });
});

describe("listWebhookEndpoints (network error path)", () => {
  it("throws a structured error when the API is unreachable", async () => {
    const client = makeClient({
      secretKey: "sk_test_x",
      baseUrl: "https://127.0.0.1:1",
    });
    await assert.rejects(() => listWebhookEndpoints(client));
  });
});
