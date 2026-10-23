import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  API_VERSION,
  createEventDestination,
  deleteEventDestination,
  listEventDestinations,
  makeClient,
} from "./mgmt-api.js";

// Request/response shapes follow docs.stripe.com/api/v2/core/event_destinations (2026-10-23).
type Call = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
};

async function withStripe(
  answer: (call: Call) => unknown,
  run: (client: ReturnType<typeof makeClient>, calls: Call[]) => Promise<void>,
) {
  const priorFetch = globalThis.fetch;
  const saved = { ro: process.env.KIT_READ_ONLY, deny: process.env.KIT_POLICY_DENY };
  delete process.env.KIT_READ_ONLY;
  delete process.env.KIT_POLICY_DENY;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      path: new URL(String(url)).pathname,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return new Response(JSON.stringify(answer(call)), { status: 200 });
  }) as typeof fetch;
  try {
    await run(makeClient({ secretKey: "sk_test_x", baseUrl: "https://api.stripe.test" }), calls);
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

const created = { id: "ed_1", webhook_endpoint: { url: null, signing_secret: "whsec_x" } };

describe("createEventDestination", () => {
  it("sends JSON, a thin payload by default, and asks for the signing secret", async () => {
    await withStripe(
      () => created,
      async (client, calls) => {
        const ed = await createEventDestination(client, {
          name: "kit",
          url: "https://example.com/hook",
          enabled_events: ["v1.charge.succeeded"],
        });
        assert.equal(ed.webhook_endpoint?.signing_secret, "whsec_x");
        const c = calls[0]!;
        assert.equal(c.path, "/v2/core/event_destinations");
        assert.equal(c.headers["Content-Type"], "application/json");
        assert.equal(c.headers["Stripe-Version"], API_VERSION);
        assert.deepEqual(c.body, {
          name: "kit",
          type: "webhook_endpoint",
          webhook_endpoint: { url: "https://example.com/hook" },
          enabled_events: ["v1.charge.succeeded"],
          event_payload: "thin",
          include: ["webhook_endpoint.signing_secret"],
        });
      },
    );
  });

  it("pins the snapshot version for snapshot payloads only", async () => {
    await withStripe(
      () => created,
      async (client, calls) => {
        await createEventDestination(client, {
          name: "kit",
          url: "https://example.com/hook",
          enabled_events: ["v1.charge.succeeded"],
          event_payload: "snapshot",
        });
        assert.equal(calls[0]!.body!.snapshot_api_version, API_VERSION);
      },
    );
  });

  it("fails loudly when Stripe returns no signing secret, since it cannot be fetched later", async () => {
    await withStripe(
      () => ({ id: "ed_2", webhook_endpoint: { signing_secret: null } }),
      async (client) =>
        assert.rejects(
          createEventDestination(client, {
            name: "k",
            url: "https://example.com/h",
            enabled_events: ["x"],
          }),
          /no signing secret/,
        ),
    );
  });
});

describe("list and delete", () => {
  it("lists data[] and deletes by id", async () => {
    await withStripe(
      (c) => (c.method === "GET" ? { data: [{ id: "ed_1" }] } : {}),
      async (client, calls) => {
        assert.deepEqual(
          (await listEventDestinations(client)).map((d) => d.id),
          ["ed_1"],
        );
        await deleteEventDestination(client, "ed_1");
        assert.deepEqual(
          calls.map((c) => `${c.method} ${c.path}`),
          ["GET /v2/core/event_destinations", "DELETE /v2/core/event_destinations/ed_1"],
        );
      },
    );
  });
});
