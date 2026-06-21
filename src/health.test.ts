import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHealth, type HealthSensor, type HealthCtx, type HealthDeps } from "./health.js";

const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };
const deps: HealthDeps = { runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }) };

describe("runHealth", () => {
  it("aggregates findings from all sensors", async () => {
    const a: HealthSensor = { id: "a", probe: async () => [{ sensor: "a", source: "x", status: "green", title: "ok" }] };
    const b: HealthSensor = { id: "b", probe: async () => [{ sensor: "b", source: "y", status: "red", severity: "high", title: "bad" }] };
    const out = await runHealth(ctx, [a, b], deps);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((f) => f.status).sort(), ["green", "red"]);
  });

  it("converts a throwing sensor into an unknown finding, never drops it", async () => {
    const boom: HealthSensor = { id: "boom", probe: async () => { throw new Error("network down"); } };
    const out = await runHealth(ctx, [boom], deps);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "unknown");
    assert.equal(out[0].sensor, "boom");
    assert.match(out[0].detail ?? "", /network down/);
  });
});
