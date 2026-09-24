import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeClient, listAppSecrets } from "./mgmt-api.js";

describe("makeClient", () => {
  it("throws when FLY_API_TOKEN is missing", () => {
    const prev = process.env.FLY_API_TOKEN;
    delete process.env.FLY_API_TOKEN;
    try {
      assert.throws(() => makeClient(), /FLY_API_TOKEN/);
    } finally {
      if (prev !== undefined) process.env.FLY_API_TOKEN = prev;
    }
  });

  it("emits a Bearer Authorization + JSON Content-Type", () => {
    const client = makeClient({ token: "fo_test_x" });
    const h = client.headers as Record<string, string>;
    assert.equal(h.Authorization, "Bearer fo_test_x");
    assert.equal(h["Content-Type"], "application/json");
    assert.equal(h["User-Agent"], "sandstream-kit-plugin-fly");
  });

  it("uses default endpoints when none configured", () => {
    const client = makeClient({ token: "fo_test_x" });
    assert.equal(client.graphqlUrl, "https://api.fly.io/graphql");
    assert.equal(client.machinesUrl, "https://api.machines.dev/v1");
  });
});

describe("listAppSecrets (network error path)", () => {
  it("throws a structured error when the API is unreachable", async () => {
    const client = makeClient({
      token: "fo_test_x",
      graphqlUrl: "https://127.0.0.1:1/graphql",
    });
    await assert.rejects(() => listAppSecrets(client, "demo-app"));
  });

  it("redacts the bearer token in API error bodies without hiding diagnostics (RED-4)", async () => {
    const priorFetch = globalThis.fetch;
    const secret = "opaque-fly-token-" + "E".repeat(32);
    globalThis.fetch = (async () =>
      new Response(`request_id=req_fly rejected credential ${secret}`, {
        status: 403,
      })) as typeof fetch;
    try {
      const client = makeClient({ token: secret, graphqlUrl: "https://api.example.test/graphql" });
      await assert.rejects(
        () => listAppSecrets(client, "demo-app"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(!err.message.includes(secret), "plugin error must not expose the secret");
          assert.match(err.message, /\[REDACTED\]/);
          assert.match(err.message, /request_id=req_fly/);
          assert.match(err.message, /403/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
