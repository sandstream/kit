import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseSupabaseLints, errorLints, supabaseAdvisorSensor } from "./supabase-advisor.js";
import type { HealthCtx, HealthDeps, HttpResponse } from "../health.js";

const lints = JSON.stringify({
  lints: [
    { name: "rls_disabled", level: "ERROR", title: "RLS disabled on public.users" },
    { name: "auth_otp_long", level: "WARN", title: "OTP expiry too long" },
  ],
});

function deps(over: { http?: HttpResponse } = {}): HealthDeps {
  return {
    runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }),
    httpGet: async () => over.http ?? { ok: true, status: 200, body: lints },
  };
}
const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };

describe("parseSupabaseLints / errorLints", () => {
  it("parses {lints:[]} and a bare array; [] on garbage", () => {
    assert.equal(parseSupabaseLints(lints).length, 2);
    assert.equal(parseSupabaseLints(JSON.stringify([{ level: "ERROR" }])).length, 1);
    assert.deepEqual(parseSupabaseLints("nope"), []);
  });
  it("keeps only ERROR-level lints", () => {
    const errs = errorLints(parseSupabaseLints(lints));
    assert.equal(errs.length, 1);
    assert.equal(errs[0].name, "rls_disabled");
  });
});

describe("supabaseAdvisorSensor.probe", () => {
  afterEach(() => {
    delete process.env.SUPABASE_ACCESS_TOKEN;
    delete process.env.SUPABASE_PROJECT_REF;
  });
  function setEnv() {
    process.env.SUPABASE_ACCESS_TOKEN = "sbp_x";
    process.env.SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst";
  }

  it("emits red (code class) on ERROR-level advisors", async () => {
    setEnv();
    const out = await supabaseAdvisorSensor.probe(ctx, deps());
    assert.equal(out[0].status, "red");
    assert.equal(out[0].suggestedClass, "code");
    assert.match(out[0].source, /supabase\/abcdef/);
    assert.match(out[0].title, /1 ERROR-level/);
  });

  it("emits green when no ERROR-level advisors", async () => {
    setEnv();
    const body = JSON.stringify({ lints: [{ level: "WARN", title: "minor" }] });
    const out = await supabaseAdvisorSensor.probe(ctx, deps({ http: { ok: true, status: 200, body } }));
    assert.equal(out[0].status, "green");
  });

  it("is unknown (not green) when token/ref not both set", async () => {
    const out = await supabaseAdvisorSensor.probe(ctx, deps());
    assert.equal(out[0].status, "unknown");
  });

  it("is unknown on a non-OK API response", async () => {
    setEnv();
    const out = await supabaseAdvisorSensor.probe(ctx, deps({ http: { ok: false, status: 401, body: "" } }));
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /401/);
  });
});
