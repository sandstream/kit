import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setSecretValue } from "./secrets-set.js";

describe("setSecretValue", () => {
  it("refuses invalid key names", async () => {
    const r = await setSecretValue({ store: "infisical" }, "-x", "value");
    assert.equal(r.ok, false);
    assert.match(r.detail, /invalid key name/);
  });

  it("refuses empty values", async () => {
    const r = await setSecretValue({ store: "infisical" }, "KEY", "");
    assert.equal(r.ok, false);
    assert.match(r.detail, /empty value/);
  });

  it("refuses when no store configured", async () => {
    const r = await setSecretValue(undefined, "KEY", "value");
    assert.equal(r.ok, false);
    assert.match(r.detail, /no vault backend/);
  });

  it("refuses when store is 'env'", async () => {
    const r = await setSecretValue({ store: "env" }, "KEY", "value");
    assert.equal(r.ok, false);
    assert.match(r.detail, /no vault backend/);
  });

  it("honors store override over config", async () => {
    // Use store override "infisical" but no CLI installed → infisical write
    // will fail at exec, but the dispatch passes the right backend.
    // We assert the failure originates downstream (write attempt), not
    // upstream (validation).
    const r = await setSecretValue(undefined, "KEY", "value", {
      store: "infisical",
    });
    // Should not be the "no vault backend" error anymore.
    assert.ok(!/no vault backend/.test(r.detail));
  });
});
