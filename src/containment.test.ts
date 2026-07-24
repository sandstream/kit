import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectContainment, parseSeccompMode, cgroupHasContainer } from "./containment.js";

describe("detectContainment", () => {
  it("returns unknown (not 'not contained') when signals are unreadable", () => {
    const v = detectContainment({ unreadable: true });
    assert.equal(v.mechanism, "unknown");
    assert.equal(v.contained, false);
    assert.equal(v.confidence, "none");
  });

  it("detects a container (high confidence when seccomp is also active)", () => {
    const v = detectContainment({ dockerEnv: true, seccompMode: 2 });
    assert.equal(v.mechanism, "container");
    assert.equal(v.contained, true);
    assert.equal(v.confidence, "high");
  });

  it("a bare container (no seccomp) is contained but heuristic", () => {
    const v = detectContainment({ cgroupContainer: true, seccompMode: 0 });
    assert.equal(v.mechanism, "container");
    assert.equal(v.contained, true);
    assert.equal(v.confidence, "heuristic");
  });

  it("seccomp alone counts as containment", () => {
    const v = detectContainment({ seccompMode: 2, dockerEnv: false, cgroupContainer: false });
    assert.equal(v.mechanism, "seccomp");
    assert.equal(v.contained, true);
  });

  it("readable but no signal ⇒ none (not unknown)", () => {
    const v = detectContainment({ dockerEnv: false, cgroupContainer: false, seccompMode: 0 });
    assert.equal(v.mechanism, "none");
    assert.equal(v.contained, false);
  });
});

describe("parseSeccompMode", () => {
  it("parses the Seccomp field", () => {
    assert.equal(parseSeccompMode("Name:\tx\nSeccomp:\t2\nNoNewPrivs:\t1\n"), 2);
    assert.equal(parseSeccompMode("Seccomp:\t0\n"), 0);
    assert.equal(parseSeccompMode("no field here"), undefined);
  });
});

describe("cgroupHasContainer", () => {
  it("detects container runtimes", () => {
    assert.equal(cgroupHasContainer("0::/docker/abc123"), true);
    assert.equal(cgroupHasContainer("0::/kubepods/pod/x"), true);
    assert.equal(cgroupHasContainer("0::/user.slice/session.scope"), false);
  });
});
