import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BACKENDS, resolveViaBackend, writeViaBackend } from "./secret-backends.js";
import type { SecretKeyConfig } from "./config.js";

describe("secret backend registry", () => {
  // The whole reason this registry exists: read and write capability live in
  // ONE object, so the old "added to the read switch, forgot the write switch"
  // silent-fail can't recur. These two assertions are that guarantee — if a
  // backend is added/removed, this test must be updated deliberately.

  it("resolves exactly the known sources", () => {
    const resolvable = Object.keys(BACKENDS).sort();
    assert.deepEqual(resolvable, [
      "1password",
      "aws-sm",
      "azure-kv",
      "bitwarden",
      "config",
      "doppler",
      "dotenvx",
      "eas",
      "env",
      "gcp-sm",
      "infisical",
      "vault",
    ]);
  });

  it("writes exactly the migration-capable backends", () => {
    const writable = Object.entries(BACKENDS)
      .filter(([, b]) => typeof b.write === "function")
      .map(([source]) => source)
      .sort();
    // env/config/eas/bitwarden are read-only — migration to them is unsupported.
    assert.deepEqual(writable, [
      "1password",
      "aws-sm",
      "azure-kv",
      "doppler",
      "dotenvx",
      "gcp-sm",
      "infisical",
      "vault",
    ]);
  });

  it("every backend exposes a resolve()", () => {
    for (const [source, backend] of Object.entries(BACKENDS)) {
      assert.equal(typeof backend.resolve, "function", `${source} missing resolve`);
    }
  });

  describe("resolveViaBackend", () => {
    it("reads from process.env for source=env", async () => {
      process.env.KIT_BACKEND_TEST_VAR = "hello-env";
      try {
        const r = await resolveViaBackend("KIT_BACKEND_TEST_VAR", { source: "env" } as SecretKeyConfig);
        assert.equal(r.resolved, true);
        assert.equal(r.value, "hello-env");
        assert.equal(r.detail, "From environment");
      } finally {
        delete process.env.KIT_BACKEND_TEST_VAR;
      }
    });

    it("reports not-set for an absent env var", async () => {
      delete process.env.KIT_BACKEND_DEFINITELY_ABSENT;
      const r = await resolveViaBackend(
        "KIT_BACKEND_DEFINITELY_ABSENT",
        { source: "env" } as SecretKeyConfig,
      );
      assert.equal(r.resolved, false);
      assert.equal(r.detail, "Not set in environment");
    });

    it("reads inline value for source=config", async () => {
      const r = await resolveViaBackend(
        "X",
        { source: "config", value: "inline-secret" } as SecretKeyConfig,
      );
      assert.equal(r.resolved, true);
      assert.equal(r.value, "inline-secret");
      assert.equal(r.detail, "From config");
    });

    it("returns a uniform message for an unknown source", async () => {
      const r = await resolveViaBackend("X", { source: "nope" } as unknown as SecretKeyConfig);
      assert.equal(r.resolved, false);
      assert.equal(r.value, null);
      assert.equal(r.detail, "Unknown source: nope");
    });
  });

  describe("writeViaBackend", () => {
    it("refuses read-only backends with the supported message", async () => {
      const r = await writeViaBackend("env", "KEY", "val", {});
      assert.equal(r.ok, false);
      assert.equal(r.detail, "migration to 'env' not yet supported — write manually");
    });

    it("refuses an unknown store", async () => {
      const r = await writeViaBackend("nope", "KEY", "val", {});
      assert.equal(r.ok, false);
      assert.equal(r.detail, "migration to 'nope' not yet supported — write manually");
    });
  });
});
