import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deleteAppSecretV1, listAppSecretsV1, makeClient, setAppSecretsV1 } from "./mgmt-api.js";

// Shapes follow docs.fly.io/api/machines/openapi.json (2026-10-23).
type Call = { method: string; path: string; body?: unknown };

async function withFly(
  answer: (call: Call) => { status: number; json: unknown },
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
      path: new URL(String(url)).pathname + new URL(String(url)).search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const { status, json } = answer(call);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  try {
    await run(
      makeClient({ token: "fo1_" + "x".repeat(40), machinesUrl: "https://machines.fly.test/v1" }),
      calls,
    );
  } finally {
    globalThis.fetch = priorFetch;
    if (priorReadOnly !== undefined) process.env.KIT_READ_ONLY = priorReadOnly;
    if (priorDeny !== undefined) process.env.KIT_POLICY_DENY = priorDeny;
  }
}

describe("Fly Machines REST secrets", () => {
  it("sets several secrets in one POST { values } and returns the secrets version", async () => {
    await withFly(
      () => ({ status: 200, json: { version: 7, secrets: [] } }),
      async (client, calls) => {
        assert.deepEqual(await setAppSecretsV1(client, "app", { A: "1", B: "2" }), { version: 7 });
        assert.deepEqual(calls, [
          { method: "POST", path: "/v1/apps/app/secrets", body: { values: { A: "1", B: "2" } } },
        ]);
      },
    );
  });

  it("deletes one secret and returns the secrets version", async () => {
    await withFly(
      () => ({ status: 200, json: { version: 8 } }),
      async (client, calls) => {
        assert.deepEqual(await deleteAppSecretV1(client, "app", "A"), { version: 8 });
        assert.deepEqual(
          calls.map((c) => `${c.method} ${c.path}`),
          ["DELETE /v1/apps/app/secrets/A"],
        );
      },
    );
  });

  it("lists names and digests, never values, and never asks for them", async () => {
    await withFly(
      () => ({ status: 200, json: { secrets: [{ name: "A", digest: "d", value: "leak" }] } }),
      async (client, calls) => {
        assert.deepEqual(await listAppSecretsV1(client, "app"), [
          { name: "A", digest: "d", created_at: undefined, updated_at: undefined },
        ]);
        assert.ok(!calls[0]!.path.includes("show_secrets"));
      },
    );
  });

  it("does not report success without a secrets version", async () => {
    await withFly(
      () => ({ status: 200, json: {} }),
      async (client) =>
        assert.rejects(setAppSecretsV1(client, "app", { A: "1" }), /no secrets version/),
    );
  });

  it("masks the values it was given in an error body", async () => {
    const value = "super-secret-value-123";
    await withFly(
      () => ({ status: 400, json: { error: `bad value ${value}` } }),
      async (client) =>
        assert.rejects(setAppSecretsV1(client, "app", { A: value }), (err: unknown) => {
          assert.ok(err instanceof Error && !err.message.includes(value));
          return true;
        }),
    );
  });

  it("is refused in read-only mode before any request", async () => {
    await withFly(
      () => ({ status: 200, json: { version: 1 } }),
      async (client, calls) => {
        process.env.KIT_READ_ONLY = "1";
        try {
          await assert.rejects(deleteAppSecretV1(client, "app", "A"), /read-only/);
          assert.equal(calls.length, 0);
        } finally {
          delete process.env.KIT_READ_ONLY;
        }
      },
    );
  });
});
