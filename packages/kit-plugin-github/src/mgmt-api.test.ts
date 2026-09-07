import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeClient, listRepoSecrets } from "./mgmt-api.js";

describe("makeClient", () => {
  it("throws when GITHUB_TOKEN is missing", () => {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      assert.throws(() => makeClient(), /GITHUB_TOKEN/);
    } finally {
      if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
    }
  });

  it("uses explicit token over env", () => {
    process.env.GITHUB_TOKEN = "env-token";
    try {
      const client = makeClient({ token: "explicit-token" });
      assert.ok(JSON.stringify(client.headers).includes("explicit-token"));
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("emits the GitHub API version + User-Agent headers", () => {
    process.env.GITHUB_TOKEN = "test";
    try {
      const client = makeClient();
      const h = client.headers as Record<string, string>;
      assert.equal(h["X-GitHub-Api-Version"], "2022-11-28");
      assert.equal(h["User-Agent"], "sandstream-kit-plugin-github");
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });
});

describe("listRepoSecrets (network error path)", () => {
  it("throws a structured error when the API is unreachable", async () => {
    const client = makeClient({
      token: "test",
      baseUrl: "https://127.0.0.1:1",
    });
    await assert.rejects(() => listRepoSecrets(client, "owner", "repo"));
  });

  it("redacts the bearer token in API error bodies without hiding diagnostics (RED-4)", async () => {
    const priorFetch = globalThis.fetch;
    const secret = "opaque-gh-token-" + "E".repeat(32);
    globalThis.fetch = (async () =>
      new Response(`request_id=req_gh rejected credential ${secret}`, {
        status: 403,
      })) as typeof fetch;
    try {
      const client = makeClient({ token: secret, baseUrl: "https://api.example.test" });
      await assert.rejects(
        () => listRepoSecrets(client, "owner", "repo"),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.ok(!err.message.includes(secret), "plugin error must not expose the secret");
          assert.match(err.message, /\[REDACTED\]/);
          assert.match(err.message, /request_id=req_gh/);
          assert.match(err.message, /403/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
