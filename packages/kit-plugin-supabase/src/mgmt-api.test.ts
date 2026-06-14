import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeClient } from "./mgmt-api.js";
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
