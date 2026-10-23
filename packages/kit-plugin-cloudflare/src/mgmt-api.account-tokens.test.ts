import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { listAccountApiTokens, makeClient, revokeAccountApiToken } from "./mgmt-api.js";

// Paths follow developers.cloudflare.com/api/resources/accounts/subresources/tokens (2026-10-23).
type Call = { method: string; path: string };

async function withCloudflare(
  run: (calls: Call[]) => Promise<void>,
  env: Record<string, string> = {},
) {
  const priorFetch = globalThis.fetch;
  const saved = { ro: process.env.KIT_READ_ONLY, deny: process.env.KIT_POLICY_DENY };
  delete process.env.KIT_READ_ONLY;
  delete process.env.KIT_POLICY_DENY;
  Object.assign(process.env, env);
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", path: new URL(String(url)).pathname });
    const result =
      (init?.method ?? "GET") === "GET" ? [{ id: "t1", name: "ci", status: "active" }] : {};
    return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = priorFetch;
    for (const [k, v] of [
      ["KIT_READ_ONLY", saved.ro],
      ["KIT_POLICY_DENY", saved.deny],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const client = (accountId?: string) =>
  makeClient({
    apiToken: "cf_" + "x".repeat(40),
    accountId,
    baseUrl: "https://api.cloudflare.test/client/v4",
  });

describe("account-owned API tokens", () => {
  it("lists and revokes under /accounts/{account_id}/tokens", async () => {
    await withCloudflare(async (calls) => {
      assert.deepEqual(
        (await listAccountApiTokens(client("acc1"))).map((t) => t.id),
        ["t1"],
      );
      await revokeAccountApiToken(client("acc1"), "t1");
      assert.deepEqual(calls, [
        { method: "GET", path: "/client/v4/accounts/acc1/tokens" },
        { method: "DELETE", path: "/client/v4/accounts/acc1/tokens/t1" },
      ]);
    });
  });

  it("needs an account id, and says so before any request", async () => {
    const prior = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      await withCloudflare(async (calls) => {
        await assert.rejects(listAccountApiTokens(client()), /accountId required/);
        assert.equal(calls.length, 0);
      });
    } finally {
      if (prior !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = prior;
    }
  });

  it("revoking is gated by api_token_revoke, the same op as user tokens", async () => {
    await withCloudflare(
      async (calls) => {
        await assert.rejects(revokeAccountApiToken(client("acc1"), "t1"), /api_token_revoke/);
        assert.equal(calls.length, 0);
      },
      { KIT_POLICY_DENY: "cloudflare:api_token_revoke" },
    );
  });
});
