import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeClient, listProjects } from "./mgmt-api.js";

describe("makeClient", () => {
  it("throws when VERCEL_TOKEN is missing", () => {
    const prev = process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TOKEN;
    try {
      assert.throws(() => makeClient(), /VERCEL_TOKEN/);
    } finally {
      if (prev !== undefined) process.env.VERCEL_TOKEN = prev;
    }
  });

  it("uses VERCEL_TEAM_ID env var when set", () => {
    process.env.VERCEL_TOKEN = "test";
    process.env.VERCEL_TEAM_ID = "team_xyz";
    try {
      const client = makeClient();
      assert.ok(client.teamQuery.includes("teamId=team_xyz"));
    } finally {
      delete process.env.VERCEL_TOKEN;
      delete process.env.VERCEL_TEAM_ID;
    }
  });

  it("uses explicit team-id over env", () => {
    process.env.VERCEL_TOKEN = "test";
    process.env.VERCEL_TEAM_ID = "team_env";
    try {
      const client = makeClient({ teamId: "team_explicit" });
      assert.ok(client.teamQuery.includes("teamId=team_explicit"));
      assert.ok(!client.teamQuery.includes("team_env"));
    } finally {
      delete process.env.VERCEL_TOKEN;
      delete process.env.VERCEL_TEAM_ID;
    }
  });

  it("returns empty teamQuery when no team id set", () => {
    process.env.VERCEL_TOKEN = "test";
    try {
      const client = makeClient();
      assert.equal(client.teamQuery, "");
    } finally {
      delete process.env.VERCEL_TOKEN;
    }
  });
});

describe("listProjects (network error path)", () => {
  it("throws a structured error when the API is unreachable", async () => {
    const client = makeClient({
      token: "test",
      baseUrl: "https://127.0.0.1:1",
    });
    await assert.rejects(() => listProjects(client));
  });

  it("redacts the bearer token in API error bodies without hiding diagnostics", async () => {
    const priorFetch = globalThis.fetch;
    const secret = "opaque-plugin-token-" + "E".repeat(32);
    globalThis.fetch = (async () =>
      new Response(`request_id=req_plugin rejected credential ${secret}`, {
        status: 403,
      })) as typeof fetch;
    try {
      const client = makeClient({ token: secret, baseUrl: "https://api.example.test" });
      await assert.rejects(
        () => listProjects(client),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(!err.message.includes(secret), "plugin error must not expose the secret");
          assert.match(err.message, /\[REDACTED\]/);
          assert.match(err.message, /request_id=req_plugin/);
          assert.match(err.message, /403/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("redacts bearer tokens from manually constructed public clients", async () => {
    const priorFetch = globalThis.fetch;
    const secret = "opaque-manual-client-token-" + "F".repeat(32);
    globalThis.fetch = (async () =>
      new Response(`rejected ${secret}`, { status: 401 })) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          listProjects({
            baseUrl: "https://api.example.test",
            headers: { Authorization: `Bearer ${secret}` },
            teamQuery: "",
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(!err.message.includes(secret));
          assert.match(err.message, /\[REDACTED\]/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
