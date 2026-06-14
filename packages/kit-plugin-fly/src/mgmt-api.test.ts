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
});
