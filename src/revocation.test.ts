import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { checkRevocationStatus, forceRevocationCheck } from "./revocation.js";

// Revocation is a kill-switch: an endpoint that is configured but unreachable /
// errors must FAIL CLOSED (assume revoked), or anyone who can disrupt the
// endpoint could disable it. These lock that behavior.
describe("revocation fail-closed", () => {
  type Cfg = Parameters<typeof forceRevocationCheck>[0];
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const enabled = {
    agent: { id: "a1" },
    revocation: { enabled: true, revocation_endpoint: "https://rev.example/{agent_id}" },
  } as unknown as Cfg;

  it("network error → fail closed (revoked: true)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    assert.equal((await forceRevocationCheck(enabled)).revoked, true);
  });

  it("non-ok response → fail closed (revoked: true)", async () => {
    globalThis.fetch = (async () => ({ ok: false, statusText: "503" })) as unknown as typeof fetch;
    assert.equal((await forceRevocationCheck(enabled)).revoked, true);
  });

  it("a clean revoked=false response is honored", async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ revoked: false }),
    })) as unknown as typeof fetch;
    assert.equal((await forceRevocationCheck(enabled)).revoked, false);
  });

  it("disabled / no endpoint → not revoked (feature off, not an error)", async () => {
    const off = { agent: { id: "a1" }, revocation: { enabled: false } } as unknown as Cfg;
    assert.equal((await forceRevocationCheck(off)).revoked, false);
  });
});

describe("forceRevocationCheck", () => {
  type Cfg = Parameters<typeof forceRevocationCheck>[0];
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;

  let calls: Array<{ url: string; init?: RequestInit }>;

  function stubFetch(impl: () => unknown) {
    calls = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return impl();
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    calls = [];
    // The fail-closed paths all console.warn; silence to keep test output readable.
    console.warn = () => {};
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  });

  const enabled = {
    agent: { id: "a1" },
    revocation: { enabled: true, revocation_endpoint: "https://rev.example/agents/{agent_id}" },
  } as unknown as Cfg;

  it("returns not-revoked for an undefined config (revocation is off by default)", async () => {
    stubFetch(() => {
      throw new Error("must not be called");
    });
    assert.deepEqual(await forceRevocationCheck(undefined), { revoked: false });
    // Feature off must not reach out to the network at all.
    assert.equal(calls.length, 0);
  });

  it("fails closed when enabled but revocation_endpoint is missing", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ revoked: false }) }));
    const noEndpoint = { agent: { id: "a1" }, revocation: { enabled: true } } as unknown as Cfg;
    // A kill-switch that is turned on but not configured must not read as "allowed".
    assert.equal((await forceRevocationCheck(noEndpoint)).revoked, true);
    assert.equal(calls.length, 0);
  });

  it("fails closed when enabled with an endpoint but no agent.id", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ revoked: false }) }));
    const noAgentId = {
      revocation: { enabled: true, revocation_endpoint: "https://rev.example/{agent_id}" },
    } as unknown as Cfg;
    assert.equal((await forceRevocationCheck(noAgentId)).revoked, true);
    assert.equal(calls.length, 0);
  });

  it("substitutes {agent_id} into the endpoint and issues a GET", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ revoked: false }) }));
    await forceRevocationCheck(enabled);
    // Querying the wrong URL would silently check the wrong agent (or nothing).
    assert.equal(calls[0]?.url, "https://rev.example/agents/a1");
    assert.equal(calls[0]?.init?.method, "GET");
  });

  it("fails closed on a 200 whose body has no boolean `revoked`", async () => {
    for (const body of [{}, { revoked: "false" }, { revoked: 0 }, null, "revoked"]) {
      stubFetch(() => ({ ok: true, json: async () => body }));
      assert.equal(
        (await forceRevocationCheck(enabled)).revoked,
        true,
        `ambiguous body ${JSON.stringify(body)} must not read as not-revoked`,
      );
    }
  });

  it("fails closed when the body cannot be parsed as JSON", async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }));
    assert.equal((await forceRevocationCheck(enabled)).revoked, true);
  });

  it("passes through reason and timestamp from a valid revoked response", async () => {
    stubFetch(() => ({
      ok: true,
      json: async () => ({
        revoked: true,
        reason: "key leaked",
        timestamp: "2026-01-02T03:04:05Z",
      }),
    }));
    // Callers surface these to the operator, so they must survive the round trip.
    assert.deepEqual(await forceRevocationCheck(enabled), {
      revoked: true,
      reason: "key leaked",
      timestamp: "2026-01-02T03:04:05Z",
    });
  });

  it("ignores the cache — every call hits the endpoint again", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ revoked: false }) }));
    await forceRevocationCheck(enabled);
    await forceRevocationCheck(enabled);
    await forceRevocationCheck(enabled);
    // This is the whole point of the "force" variant vs checkRevocationStatus.
    assert.equal(calls.length, 3);
  });

  it("writes a clean verdict into the cache shared with checkRevocationStatus", async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ revoked: true }) }));
    assert.equal((await forceRevocationCheck(enabled)).revoked, true);

    stubFetch(() => {
      throw new Error("must not be called");
    });
    // The fresh cache entry from the force check satisfies the interval check,
    // so no second request is made.
    assert.equal(await checkRevocationStatus(enabled), true);
    assert.equal(calls.length, 0);
  });

  it("does not overwrite the cache with a fail-closed result", async () => {
    // Seed the shared cache with a real not-revoked verdict.
    stubFetch(() => ({ ok: true, json: async () => ({ revoked: false }) }));
    await forceRevocationCheck(enabled);

    stubFetch(() => {
      throw new Error("network down");
    });
    // The caller still sees the fail-closed answer...
    assert.equal((await forceRevocationCheck(enabled)).revoked, true);

    stubFetch(() => {
      throw new Error("must not be called");
    });
    // ...but the transient failure was not cached as a verdict, so a recovered
    // agent is not pinned into "revoked" until the TTL expires.
    assert.equal(await checkRevocationStatus(enabled), false);
    assert.equal(calls.length, 0);
  });
});
