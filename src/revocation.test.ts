import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { forceRevocationCheck } from "./revocation.js";

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
