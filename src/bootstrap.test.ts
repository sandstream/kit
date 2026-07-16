import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planBootstrap,
  classifyStep,
  summarize,
  isFatal,
  type BootstrapSeed,
  type StepResult,
} from "./bootstrap.js";

const bareSeed: BootstrapSeed = { controlPlane: false };

describe("planBootstrap — step order + fail modes", () => {
  it("always plans config + identity as fail-closed floor, first", () => {
    const plan = planBootstrap(bareSeed);
    assert.equal(plan[0].id, "config");
    assert.deepEqual(plan[0].argv, ["setup", "--recommended"]);
    assert.equal(plan[0].failMode, "fail-closed");
    assert.equal(plan[1].id, "identity");
    assert.deepEqual(plan[1].argv, ["identity", "init"]);
    assert.equal(plan[1].failMode, "fail-closed");
  });

  it("--minimal switches the config step to setup --minimal", () => {
    const plan = planBootstrap(bareSeed, { minimal: true });
    assert.deepEqual(plan[0].argv, ["setup", "--minimal"]);
  });

  it("skips policy without a control plane, runs it with one (fail-closed both ways)", () => {
    const off = planBootstrap({ controlPlane: false }).find((s) => s.id === "policy")!;
    assert.equal(off.argv, null);
    assert.match(off.skippedReason!, /control plane/);
    assert.equal(off.failMode, "fail-closed");

    const on = planBootstrap({ controlPlane: true }).find((s) => s.id === "policy")!;
    assert.deepEqual(on.argv, ["policy", "pull"]);
    assert.equal(on.failMode, "fail-closed");
  });

  it("plans profile import only with a bundle; integrity step is fail-closed", () => {
    assert.equal(planBootstrap(bareSeed).find((s) => s.id === "profile")!.argv, null);
    const p = planBootstrap({ ...bareSeed, profileBundle: "/b.json" }).find(
      (s) => s.id === "profile",
    )!;
    assert.deepEqual(p.argv, ["profile", "import", "/b.json"]);
    assert.equal(p.failMode, "fail-closed");
  });

  it("recall is fail-open: runs with a backup, skips without, skips on --no-memory", () => {
    const withBak = planBootstrap({ ...bareSeed, memoryBackup: "/m.enc" }).find(
      (s) => s.id === "recall",
    )!;
    assert.deepEqual(withBak.argv, ["memory", "restore", "/m.enc"]);
    assert.equal(withBak.failMode, "fail-open");

    const noBak = planBootstrap(bareSeed).find((s) => s.id === "recall")!;
    assert.equal(noBak.argv, null);
    assert.equal(noBak.failMode, "fail-open");

    const noMem = planBootstrap({ ...bareSeed, memoryBackup: "/m.enc" }, { noMemory: true }).find(
      (s) => s.id === "recall",
    )!;
    assert.equal(noMem.argv, null);
    assert.match(noMem.skippedReason!, /no-memory/);
  });

  it("never plans a secrets step (setup resolves them lazily)", () => {
    assert.equal(
      planBootstrap({
        ...bareSeed,
        profileBundle: "/b",
        memoryBackup: "/m",
        controlPlane: true,
      }).some((s) => (s.id as string) === "secrets"),
      false,
    );
  });
});

describe("classifyStep — the fail matrix", () => {
  const closed = { id: "config" as const, argv: ["setup"], failMode: "fail-closed" as const };
  const open = {
    id: "recall" as const,
    argv: ["memory", "restore", "x"],
    failMode: "fail-open" as const,
  };

  it("ok when the step ran", () => {
    assert.equal(classifyStep(closed, true).status, "ok");
  });
  it("a failed fail-closed step is 'failed' (fatal)", () => {
    const r = classifyStep(closed, false);
    assert.equal(r.status, "failed");
    assert.equal(isFatal(r), true);
  });
  it("a failed fail-open step is 'degraded' (not fatal)", () => {
    const r = classifyStep(open, false);
    assert.equal(r.status, "degraded");
    assert.equal(isFatal(r), false);
  });
  it("a null-argv step is 'skipped' with its reason", () => {
    const r = classifyStep(
      { id: "policy", argv: null, failMode: "fail-closed", skippedReason: "no cp" },
      null,
    );
    assert.equal(r.status, "skipped");
    assert.equal(r.detail, "no cp");
  });
});

describe("summarize — overall verdict", () => {
  const R = (status: StepResult["status"]): StepResult => ({
    id: "config",
    status,
    failMode: status === "degraded" ? "fail-open" : "fail-closed",
    detail: "",
  });

  it("ok when every step is ok/skipped", () => {
    const r = summarize([R("ok"), R("skipped"), R("ok")]);
    assert.equal(r.ok, true);
    assert.equal(r.degraded, false);
  });
  it("ok-but-degraded when a fail-open step degraded", () => {
    const r = summarize([R("ok"), R("degraded")]);
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
  });
  it("NOT ok when a fail-closed step failed", () => {
    const r = summarize([R("ok"), R("failed")]);
    assert.equal(r.ok, false);
  });
});
