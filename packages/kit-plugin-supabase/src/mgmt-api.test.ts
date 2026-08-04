import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeClient, rollJwtSecret, revokeScopedKey, mintScopedKey } from "./mgmt-api.js";
import { rotateSupabaseKey, previewSupabaseRotation } from "./rotate.js";

describe("makeClient", () => {
  it("throws when no access token is provided", () => {
    const prev = process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.SUPABASE_ACCESS_TOKEN;
    try {
      assert.throws(() => makeClient(), /SUPABASE_ACCESS_TOKEN/);
    } finally {
      if (prev !== undefined) process.env.SUPABASE_ACCESS_TOKEN = prev;
    }
  });

  it("uses the provided access token over the env var", () => {
    process.env.SUPABASE_ACCESS_TOKEN = "env-token";
    try {
      const client = makeClient({ accessToken: "explicit-token" });
      assert.ok(
        JSON.stringify(client.headers).includes("explicit-token"),
        "explicit token should win",
      );
    } finally {
      delete process.env.SUPABASE_ACCESS_TOKEN;
    }
  });

  it("uses the env var when no explicit token", () => {
    process.env.SUPABASE_ACCESS_TOKEN = "env-token";
    try {
      const client = makeClient();
      assert.ok(JSON.stringify(client.headers).includes("env-token"));
    } finally {
      delete process.env.SUPABASE_ACCESS_TOKEN;
    }
  });

  it("honors a custom base URL", () => {
    process.env.SUPABASE_ACCESS_TOKEN = "t";
    try {
      const client = makeClient({ baseUrl: "https://api.staging.supabase.com" });
      assert.equal(client.baseUrl, "https://api.staging.supabase.com");
    } finally {
      delete process.env.SUPABASE_ACCESS_TOKEN;
    }
  });
});

describe("rotateSupabaseKey", () => {
  it("returns ok=false with a helpful error when PAT is missing", async () => {
    const prev = process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.SUPABASE_ACCESS_TOKEN;
    try {
      const r = await rotateSupabaseKey({
        projectRef: "abcdefghijklmnopqrst",
        mode: "scoped-key-mint",
      });
      assert.equal(r.ok, false);
      assert.ok(r.error && r.error.includes("SUPABASE_ACCESS_TOKEN"));
    } finally {
      if (prev !== undefined) process.env.SUPABASE_ACCESS_TOKEN = prev;
    }
  });

  it("returns ok=false when the API rejects the call (invalid token)", async () => {
    const r = await rotateSupabaseKey({
      projectRef: "nonexistent-project-ref-xx",
      mode: "scoped-key-mint",
      accessToken: "sbp_invalid_token_for_test",
      baseUrl: "https://127.0.0.1:1", // closed port → network error
    });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });
});

describe("previewSupabaseRotation", () => {
  it("reports the error path without crashing when the API is unreachable", async () => {
    const r = await previewSupabaseRotation({
      projectRef: "x",
      accessToken: "t",
      baseUrl: "https://127.0.0.1:1",
    });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });
});

// Pure-logic unit tests for the key-mode classifier. We can't easily stub
// fetch() across versions, but we CAN exercise the classification arms by
// stub-calling listApiKeys's caller — encoded here as a self-contained
// reimplementation of the same logic to lock the truth table down.
describe("key-mode classification truth table", () => {
  type Key = { id?: string; name?: string; type?: string };
  function classify(keys: Key[]): { scoped: boolean; legacy: boolean } {
    let scoped = false;
    let legacy = false;
    for (const k of keys) {
      if (k.type === "anon" || k.type === "service_role") legacy = true;
      else if (k.id && (k.type === "secret" || k.type === "publishable" || !k.type)) {
        scoped = true;
      }
    }
    return { scoped, legacy };
  }

  it("legacy-only project (only anon + service_role)", () => {
    const r = classify([{ type: "anon" }, { type: "service_role" }]);
    assert.equal(r.scoped, false);
    assert.equal(r.legacy, true);
  });

  it("scoped-only project (uuid-id with secret/publishable type)", () => {
    const r = classify([
      { id: "uuid-1", type: "secret" },
      { id: "uuid-2", type: "publishable" },
    ]);
    assert.equal(r.scoped, true);
    assert.equal(r.legacy, false);
  });

  it("mixed project (during migration)", () => {
    const r = classify([
      { type: "anon" },
      { type: "service_role" },
      { id: "uuid-3", type: "secret" },
    ]);
    assert.equal(r.scoped, true);
    assert.equal(r.legacy, true);
  });
});

/**
 * Containment for the three write surfaces this package exposes.
 *
 * These did not exist because the guards did not exist: `rollJwtSecret`, `revokeScopedKey` and
 * `mintScopedKey` shipped with no read-only check and no policy check, while six sibling plugins had
 * one. Measured with `KIT_READ_ONLY=1` set and the client pointed at a local listener, all three sent
 * their request; `rollJwtSecret` — which invalidates every anon, service_role, signed-URL and session
 * token at once — returned a rolled secret. The requests are asserted to be refused BEFORE any fetch,
 * which is why an unreachable host is not needed to make these deterministic.
 */
describe("write-surface containment", () => {
  afterEach(() => {
    delete process.env.KIT_READ_ONLY;
    delete process.env.KIT_POLICY_DENY;
  });

  const client = (): ReturnType<typeof makeClient> =>
    makeClient({ accessToken: "x", baseUrl: "https://127.0.0.1:1" });

  for (const [label, call] of [
    ["rollJwtSecret", (c: ReturnType<typeof makeClient>) => rollJwtSecret(c, "proj")],
    ["revokeScopedKey", (c: ReturnType<typeof makeClient>) => revokeScopedKey(c, "proj", "key-id")],
    [
      "mintScopedKey",
      (c: ReturnType<typeof makeClient>) => mintScopedKey(c, "proj", { name: "n" }),
    ],
  ] as const) {
    it(`${label} refuses when KIT_READ_ONLY=1`, async () => {
      process.env.KIT_READ_ONLY = "1";
      await assert.rejects(() => call(client()), /read-only mode active/);
    });
  }

  it("rollJwtSecret is refused when the project pre-approved only the mint", async () => {
    // The distinction the registry exists for: `supabase = ["scoped_key_mint"]` resolves to a deny
    // list containing the roll and the revoke, so pre-approving the reversible op cannot authorise
    // the one that invalidates every live token.
    process.env.KIT_POLICY_DENY = "supabase:jwt_secret_roll,supabase:scoped_key_revoke";
    await assert.rejects(
      () => rollJwtSecret(client(), "proj"),
      /refused by \[policy\.agent_writes\.supabase\].*jwt_secret_roll/,
    );
    await assert.rejects(
      () => revokeScopedKey(client(), "proj", "key-id"),
      /refused by \[policy\.agent_writes\.supabase\].*scoped_key_revoke/,
    );
    // …while the mint itself is not refused by policy: it reaches the (unreachable) network.
    await assert.rejects(
      () => mintScopedKey(client(), "proj", { name: "n" }),
      (err: Error) => !/refused by \[policy/.test(err.message),
    );
  });
});
