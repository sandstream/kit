import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeClient, revokeSigningKey, rotateSigningKey } from "./mgmt-api.js";

// Request and response shapes follow api.supabase.com/api/v1-json (2026-10-23).
type Call = { method: string; path: string; body?: { status?: string; algorithm?: string } };
type Key = { id: string; algorithm: string; status: string };

async function withSupabase(
  keys: Key[],
  run: (client: ReturnType<typeof makeClient>, calls: Call[]) => Promise<void>,
  opts: { failActivation?: boolean } = {},
) {
  const priorFetch = globalThis.fetch;
  const priorReadOnly = process.env.KIT_READ_ONLY;
  const priorDeny = process.env.KIT_POLICY_DENY;
  delete process.env.KIT_READ_ONLY;
  delete process.env.KIT_POLICY_DENY;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = new URL(String(url)).pathname.replace(/^\/v1\/projects\/ref\/config\/auth/, "");
    calls.push({ method, path, body });
    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status });
    if (method === "GET") return json(200, { keys });
    if (method === "POST")
      return json(201, { id: "new", algorithm: body.algorithm, status: body.status });
    const id = path.split("/").pop()!;
    if (opts.failActivation && body.status === "in_use") return json(400, { message: "nope" });
    return json(200, { id, algorithm: "ES256", status: body.status });
  }) as typeof fetch;
  try {
    await run(
      makeClient({ accessToken: "sbp_" + "x".repeat(40), baseUrl: "https://api.supabase.test" }),
      calls,
    );
  } finally {
    globalThis.fetch = priorFetch;
    if (priorReadOnly !== undefined) process.env.KIT_READ_ONLY = priorReadOnly;
    if (priorDeny !== undefined) process.env.KIT_POLICY_DENY = priorDeny;
  }
}

const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path} ${c.body?.status}`);

describe("rotateSigningKey", () => {
  it("creates standby, activates it, THEN demotes the old key, and revokes nothing", async () => {
    await withSupabase(
      [
        { id: "old", algorithm: "HS256", status: "in_use" },
        { id: "older", algorithm: "HS256", status: "previously_used" },
      ],
      async (client, calls) => {
        const r = await rotateSigningKey(client, "ref");
        assert.deepEqual(writes(calls), [
          "POST /signing-keys standby",
          "PATCH /signing-keys/new in_use",
          "PATCH /signing-keys/old previously_used",
        ]);
        assert.equal(r.activated.status, "in_use");
        assert.deepEqual(
          r.demoted.map((k) => k.id),
          ["old"],
        );
        assert.equal(calls.find((c) => c.method === "POST")!.body!.algorithm, "ES256");
      },
    );
  });

  it("demotes nothing when activation fails, so the project keeps its key in use", async () => {
    await withSupabase(
      [{ id: "old", algorithm: "HS256", status: "in_use" }],
      async (client, calls) => {
        await assert.rejects(
          rotateSigningKey(client, "ref"),
          /activate signing key new returned 400/,
        );
        assert.ok(!writes(calls).some((w) => w.includes("/old ")), "the old key must stay in use");
      },
      { failActivation: true },
    );
  });

  it("is refused in read-only mode before any request", async () => {
    await withSupabase([], async (client, calls) => {
      process.env.KIT_READ_ONLY = "1";
      try {
        await assert.rejects(rotateSigningKey(client, "ref"), /read-only/);
        assert.equal(calls.length, 0);
      } finally {
        delete process.env.KIT_READ_ONLY;
      }
    });
  });
});

describe("revokeSigningKey", () => {
  it("revokes a previously used key", async () => {
    await withSupabase(
      [{ id: "old", algorithm: "HS256", status: "previously_used" }],
      async (client, calls) => {
        assert.equal((await revokeSigningKey(client, "ref", "old")).status, "revoked");
        assert.deepEqual(writes(calls), ["PATCH /signing-keys/old revoked"]);
      },
    );
  });

  it("refuses to revoke the key in use", async () => {
    await withSupabase(
      [{ id: "cur", algorithm: "ES256", status: "in_use" }],
      async (client, calls) => {
        await assert.rejects(revokeSigningKey(client, "ref", "cur"), /it is the key in use/);
        assert.deepEqual(writes(calls), []);
      },
    );
  });
});
