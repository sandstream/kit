import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectContainment,
  parseSeccompMode,
  cgroupHasContainer,
  detectGvisorMarker,
  detectFirecrackerMarker,
  containmentEnforcement,
} from "./containment.js";

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

describe("detectGvisorMarker", () => {
  it("matches a gVisor / runsc fingerprint (positive only)", () => {
    assert.equal(detectGvisorMarker("Linux version 4.4.0 ... gVisor"), true);
    assert.equal(detectGvisorMarker("runsc sandbox"), true);
    assert.equal(detectGvisorMarker("Linux version 6.1.0-generic (gcc ...)"), false);
    assert.equal(detectGvisorMarker(""), false);
  });
});

describe("detectFirecrackerMarker", () => {
  it("matches a Firecracker fingerprint (positive only)", () => {
    assert.equal(detectFirecrackerMarker("Amazon Firecracker"), true);
    assert.equal(detectFirecrackerMarker("product_name: Standard PC (i440FX)"), false);
    assert.equal(detectFirecrackerMarker(""), false);
  });
});

describe("detectContainment — sandboxed runtimes", () => {
  it("names gVisor and is contained (heuristic) on a positive fingerprint", () => {
    const v = detectContainment({ gvisorMarker: true });
    assert.equal(v.mechanism, "gvisor");
    assert.equal(v.contained, true);
    assert.equal(v.confidence, "heuristic");
  });
  it("names Firecracker on a positive fingerprint", () => {
    const v = detectContainment({ firecrackerMarker: true });
    assert.equal(v.mechanism, "firecracker");
    assert.equal(v.contained, true);
  });
  it("absence of a fingerprint never downgrades — still resolves via container/seccomp signals", () => {
    // No gvisor/firecracker marker, but a real container signal is present.
    const v = detectContainment({ cgroupContainer: true, seccompMode: 2 });
    assert.equal(v.mechanism, "container");
    assert.equal(v.contained, true);
  });
});

describe("containmentEnforcement (fail-closed)", () => {
  const contained = detectContainment({ cgroupContainer: true, seccompMode: 2 });
  const none = detectContainment({ cgroupContainer: false, seccompMode: 0 });
  const unknown = detectContainment({ unreadable: true });

  it("skips when containment is not required", () => {
    assert.equal(containmentEnforcement(none, false).status, "skip");
  });
  it("passes when required and containment is present", () => {
    assert.equal(containmentEnforcement(contained, true).status, "pass");
  });
  it("FAILS when required but not contained", () => {
    assert.equal(containmentEnforcement(none, true).status, "fail");
  });
  it("FAILS when required but undeterminable (fail-closed, not a pass)", () => {
    const r = containmentEnforcement(unknown, true);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /cannot be determined/);
  });
});
