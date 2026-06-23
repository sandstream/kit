import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runHealth, type HealthSensor, type HealthCtx, type HealthDeps } from "./health.js";
import { selectSensors, defaultHealthDeps, HEALTH_SENSORS } from "./health.js";

const ctx: HealthCtx = { cwd: "/tmp/repo", config: {} };
const deps: HealthDeps = {
  runCli: async () => ({ stdout: "", stderr: "", exitCode: 0, ok: true }),
  httpGet: async () => ({ ok: true, status: 200, body: "" }),
};

describe("runHealth", () => {
  it("aggregates findings from all sensors", async () => {
    const a: HealthSensor = {
      id: "a",
      probe: async () => [{ sensor: "a", source: "x", status: "green", title: "ok" }],
    };
    const b: HealthSensor = {
      id: "b",
      probe: async () => [
        { sensor: "b", source: "y", status: "red", severity: "high", title: "bad" },
      ],
    };
    const out = await runHealth(ctx, [a, b], deps);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((f) => f.status).sort(), ["green", "red"]);
  });

  it("converts a throwing sensor into an unknown finding, never drops it", async () => {
    const boom: HealthSensor = {
      id: "boom",
      probe: async () => {
        throw new Error("network down");
      },
    };
    const out = await runHealth(ctx, [boom], deps);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "unknown");
    assert.equal(out[0].sensor, "boom");
    assert.match(out[0].detail ?? "", /network down/);
  });
});

describe("selectSensors", () => {
  it("includes github-actions when a git remote is present", () => {
    const sel = selectSensors({ cwd: "/tmp/repo", config: {}, gitRemote: true });
    assert.ok(sel.some((s) => s.id === "github-actions"));
  });

  it("excludes github-actions with no git remote and no github context", () => {
    const sel = selectSensors({ cwd: "/tmp/repo", config: {}, gitRemote: false });
    assert.equal(
      sel.some((s) => s.id === "github-actions"),
      false,
    );
  });

  it("includes gitlab-ci only when a .gitlab-ci.yml is present", () => {
    assert.ok(
      selectSensors({ cwd: "/r", config: {}, gitlabCi: true }).some((s) => s.id === "gitlab-ci"),
    );
    assert.equal(
      selectSensors({ cwd: "/r", config: {} }).some((s) => s.id === "gitlab-ci"),
      false,
    );
  });

  it("includes bitbucket-pipelines only when a bitbucket-pipelines.yml is present", () => {
    assert.ok(
      selectSensors({ cwd: "/r", config: {}, bitbucketPipelines: true }).some(
        (s) => s.id === "bitbucket-pipelines",
      ),
    );
    assert.equal(
      selectSensors({ cwd: "/r", config: {} }).some((s) => s.id === "bitbucket-pipelines"),
      false,
    );
  });

  it("registry has all three CI sensors and defaultHealthDeps exposes runCli + httpGet", () => {
    assert.ok(HEALTH_SENSORS.length >= 3);
    assert.equal(typeof defaultHealthDeps.runCli, "function");
    assert.equal(typeof defaultHealthDeps.httpGet, "function");
  });
});
