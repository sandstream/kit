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
});
