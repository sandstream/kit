import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseResendDomains, unverifiedDomains, resendSensor } from "./resend.js";
import type { HealthCtx, HealthDeps, HttpResponse } from "../health.js";

const domains = JSON.stringify({
  data: [
    { id: "1", name: "mail.acme.com", status: "verified" },
    { id: "2", name: "gamedaydj.example", status: "failed" },
  ],
});

function deps(over: { http?: HttpResponse } = {}): HealthDeps {
  return {
    runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }),
    httpGet: async () => over.http ?? { ok: true, status: 200, body: domains },
  };
}
const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };

describe("parseResendDomains / unverifiedDomains", () => {
  it("flags any domain not 'verified'", () => {
    const bad = unverifiedDomains(parseResendDomains(domains));
    assert.equal(bad.length, 1);
    assert.equal(bad[0].name, "gamedaydj.example");
  });
  it("returns [] when all verified", () => {
    const all = JSON.stringify({ data: [{ name: "a", status: "verified" }] });
    assert.deepEqual(unverifiedDomains(parseResendDomains(all)), []);
  });
});

describe("resendSensor.probe", () => {
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it("emits red (human class) when a domain is unverified", async () => {
    process.env.RESEND_API_KEY = "re_x";
    const out = await resendSensor.probe(ctx, deps());
    assert.equal(out[0].status, "red");
    assert.equal(out[0].suggestedClass, "human");
    assert.match(out[0].title, /not verified/);
  });

  it("emits green when all domains verified", async () => {
    process.env.RESEND_API_KEY = "re_x";
    const all = JSON.stringify({ data: [{ name: "a", status: "verified" }] });
    const out = await resendSensor.probe(ctx, deps({ http: { ok: true, status: 200, body: all } }));
    assert.equal(out[0].status, "green");
  });

  it("is unknown (not green) when RESEND_API_KEY is missing", async () => {
    const out = await resendSensor.probe(ctx, deps());
    assert.equal(out[0].status, "unknown");
  });

  it("is unknown on a non-OK API response", async () => {
    process.env.RESEND_API_KEY = "re_x";
    const out = await resendSensor.probe(ctx, deps({ http: { ok: false, status: 401, body: "" } }));
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /401/);
  });
});
