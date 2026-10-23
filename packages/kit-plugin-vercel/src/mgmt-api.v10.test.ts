import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createEnvVar,
  listEnvVars,
  listProjects,
  makeClient,
  redeployLatest,
  upsertEnvVar,
} from "./mgmt-api.js";

// Shapes below are taken from openapi.vercel.sh (2026-10-23), the paths kit moved to.
type Call = { method: string; url: string; body: unknown };

async function withVercel(
  answer: (call: Call) => unknown,
  run: (client: ReturnType<typeof makeClient>, calls: Call[]) => Promise<void>,
) {
  const priorFetch = globalThis.fetch;
  const priorReadOnly = process.env.KIT_READ_ONLY;
  const priorDeny = process.env.KIT_POLICY_DENY;
  delete process.env.KIT_READ_ONLY;
  delete process.env.KIT_POLICY_DENY;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return new Response(JSON.stringify(answer(call)), {
      status: call.method === "POST" ? 201 : 200,
    });
  }) as typeof fetch;
  try {
    await run(
      makeClient({ token: "tok_" + "x".repeat(24), baseUrl: "https://api.vercel.test" }),
      calls,
    );
  } finally {
    globalThis.fetch = priorFetch;
    if (priorReadOnly !== undefined) process.env.KIT_READ_ONLY = priorReadOnly;
    if (priorDeny !== undefined) process.env.KIT_POLICY_DENY = priorDeny;
  }
}

describe("Vercel v10 / v7 paths", () => {
  it("reads projects from v10 in both the array and the { projects } form", async () => {
    await withVercel(
      () => [{ id: "p1", name: "a" }],
      async (client, calls) => {
        assert.deepEqual(
          (await listProjects(client)).map((p) => p.id),
          ["p1"],
        );
        assert.match(calls[0]!.url, /\/v10\/projects/);
      },
    );
    await withVercel(
      () => ({ projects: [{ id: "p2", name: "b" }], pagination: {} }),
      async (client) =>
        assert.deepEqual(
          (await listProjects(client)).map((p) => p.id),
          ["p2"],
        ),
    );
  });

  it("lists env vars from v10", async () => {
    await withVercel(
      () => ({ envs: [{ id: "e1", key: "K", target: ["production"] }], pagination: {} }),
      async (client, calls) => {
        assert.deepEqual(
          (await listEnvVars(client, "p")).map((e) => e.id),
          ["e1"],
        );
        assert.match(calls[0]!.url, /\/v10\/projects\/p\/env/);
      },
    );
  });

  it("finds the latest deployment on v7", async () => {
    await withVercel(
      (call) =>
        call.method === "GET"
          ? { deployments: [{ uid: "d1", name: "app" }], pagination: {} }
          : { id: "d2", url: "app-2.vercel.app" },
      async (client, calls) => {
        assert.equal((await redeployLatest(client, "p")).id, "d2");
        assert.match(calls[0]!.url, /\/v7\/deployments/);
      },
    );
  });
});

describe("createEnvVar reads v10's { created, failed }", () => {
  it("returns the created entry and can create a write-only sensitive var", async () => {
    await withVercel(
      () => ({
        created: { id: "e9", key: "API_KEY", target: ["production"], type: "sensitive" },
        failed: [],
      }),
      async (client, calls) => {
        const env = await createEnvVar(client, "p", {
          key: "API_KEY",
          value: "v".repeat(16),
          target: ["production"],
          type: "sensitive",
        });
        assert.equal(env.id, "e9");
        assert.equal((calls[0]!.body as { type: string }).type, "sensitive");
      },
    );
  });

  it("treats a 201 that lists the key under `failed` as a failure", async () => {
    await withVercel(
      () => ({ failed: [{ error: { code: "ENV_CONFLICT", key: "API_KEY" } }] }),
      async (client) =>
        assert.rejects(
          createEnvVar(client, "p", {
            key: "API_KEY",
            value: "v".repeat(16),
            target: ["production"],
          }),
          /rejected API_KEY \(ENV_CONFLICT\)/,
        ),
    );
  });

  it("never deletes the old entries when the replacement was rejected", async () => {
    // Conflict path of upsertEnvVar: create-then-delete. A rejected create must stop it.
    await withVercel(
      (call) =>
        call.method === "GET"
          ? { envs: [{ id: "old", key: "API_KEY", target: ["production", "preview"] }] }
          : { failed: [{ error: { code: "ENV_CONFLICT" } }] },
      async (client, calls) => {
        await assert.rejects(
          upsertEnvVar(client, "p", {
            key: "API_KEY",
            value: "v".repeat(16),
            target: ["production"],
          }),
          /rejected/,
        );
        assert.deepEqual(
          calls.map((c) => c.method),
          ["GET", "POST"],
          "no DELETE may follow a rejected create",
        );
      },
    );
  });
});
