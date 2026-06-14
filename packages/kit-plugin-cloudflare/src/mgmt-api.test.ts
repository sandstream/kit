import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeClient, listWorkerSecrets, listApiTokens } from "./mgmt-api.js";

describe("makeClient", () => {
  it("throws when CLOUDFLARE_API_TOKEN is missing", () => {
    const prev = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      assert.throws(() => makeClient(), /CLOUDFLARE_API_TOKEN/);
    } finally {
      if (prev !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev;
    }
  });

  it("emits Bearer auth + default base URL", () => {
    const client = makeClient({ apiToken: "cf_test_x" });
    const h = client.headers as Record<string, string>;
    assert.equal(h.Authorization, "Bearer cf_test_x");
    assert.equal(client.baseUrl, "https://api.cloudflare.com/client/v4");
  });

  it("picks up accountId from env when not passed", () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-123";
    try {
      const client = makeClient({ apiToken: "cf_test_x" });
      assert.equal(client.accountId, "acct-123");
    } finally {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    }
  });
});

describe("listWorkerSecrets", () => {
  it("refuses to run without an accountId", async () => {
    const client = makeClient({ apiToken: "cf_test_x" });
    await assert.rejects(() => listWorkerSecrets(client, "worker-name"), /accountId required/);
  });

  it("throws a structured error when the API is unreachable", async () => {
    const client = makeClient({
      apiToken: "cf_test_x",
      accountId: "acct-x",
      baseUrl: "https://127.0.0.1:1",
    });
    await assert.rejects(() => listWorkerSecrets(client, "worker-name"));
  });
});

describe("listApiTokens (network error path)", () => {
  it("throws a structured error when the API is unreachable", async () => {
    const client = makeClient({
      apiToken: "cf_test_x",
      baseUrl: "https://127.0.0.1:1",
    });
    await assert.rejects(() => listApiTokens(client));
  });
});
