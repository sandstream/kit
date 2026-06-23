import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseVercelDeployments, latestFailedVercel, vercelSensor } from "./vercel.js";
import type { HealthCtx, HealthDeps, HttpResponse } from "../health.js";

const body = JSON.stringify({
  deployments: [
    { uid: "dpl_3", state: "ERROR", target: "production", created: 3000 },
    { uid: "dpl_2", state: "READY", target: "production", created: 2000 },
    { uid: "dpl_4", state: "BUILDING", target: "production", created: 4000 },
  ],
});

function deps(over: { http?: HttpResponse } = {}): HealthDeps {
  return {
    runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }),
    httpGet: async () => over.http ?? { ok: true, status: 200, body },
  };
}
const linked: HealthCtx = {
  cwd: "/tmp/repo",
  config: {},
  vercel: { orgId: "team_1", projectId: "prj_abc" },
};

describe("parseVercelDeployments / latestFailedVercel", () => {
  it("flags the latest TERMINAL deploy when it errored (ignores in-progress BUILDING)", () => {
    const f = latestFailedVercel(parseVercelDeployments(body));
    assert.equal(f?.uid, "dpl_3");
  });
  it("returns null when the latest terminal deploy is READY", () => {
    const ok = JSON.stringify({
      deployments: [{ uid: "x", state: "READY", target: "production", created: 9 }],
    });
    assert.equal(latestFailedVercel(parseVercelDeployments(ok)), null);
  });
  it("treats CANCELED as not-red", () => {
    const c = JSON.stringify({
      deployments: [{ uid: "x", state: "CANCELED", target: "production", created: 9 }],
    });
    assert.equal(latestFailedVercel(parseVercelDeployments(c)), null);
  });
  it("supports readyState as the state field alias", () => {
    const r = JSON.stringify({
      deployments: [{ uid: "x", readyState: "ERROR", target: "production", created: 9 }],
    });
    assert.equal(latestFailedVercel(parseVercelDeployments(r))?.uid, "x");
  });
});

describe("vercelSensor.probe", () => {
  afterEach(() => {
    delete process.env.VERCEL_TOKEN;
  });

  it("emits red when the latest production deploy errored", async () => {
    process.env.VERCEL_TOKEN = "vt";
    const out = await vercelSensor.probe(linked, deps());
    assert.equal(out[0].status, "red");
    assert.equal(out[0].source, "prj_abc");
    assert.equal(out[0].suggestedClass, "code");
  });

  it("is unknown when the project is not linked (no .vercel/project.json)", async () => {
    process.env.VERCEL_TOKEN = "vt";
    const out = await vercelSensor.probe({ cwd: "/r", config: {} }, deps());
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /not linked/);
  });

  it("is unknown (not green) when VERCEL_TOKEN is missing", async () => {
    const out = await vercelSensor.probe(linked, deps());
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /VERCEL_TOKEN/);
  });

  it("is unknown on a non-OK API response", async () => {
    process.env.VERCEL_TOKEN = "vt";
    const out = await vercelSensor.probe(
      linked,
      deps({ http: { ok: false, status: 403, body: "" } }),
    );
    assert.equal(out[0].status, "unknown");
    assert.match(out[0].title, /403/);
  });
});
