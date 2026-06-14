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
});
