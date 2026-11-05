import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectContainment,
  parseSeccompMode,
  cgroupHasContainer,
  detectGvisorMarker,
  detectFirecrackerMarker,
  containmentEnforcement,
  cgroupHasGvisorJobController,
  gatherContainmentSignals,
  parseCpuHypervisor,
} from "./containment.js";
import { readFileSync } from "node:fs";
import { containmentPostureStatus } from "./doctor.js";

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

  it("matches the REAL /proc/version from a live gVisor sandbox (runsc 20260721.0)", () => {
    // Captured verbatim via `sudo runsc do cat /proc/version` on Ubuntu 24.04 (Hetzner KVM).
    // Keep byte-exact: this fixture is why the fingerprint is verified, not doc-derived.
    const real = "Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016";
    assert.equal(detectGvisorMarker(real), true);
    assert.equal(detectFirecrackerMarker(real), false, "must not cross-match Firecracker");
  });

  it("does not fire on real non-gVisor kernels or the host's DMI product name", () => {
    // Negative controls captured from real hosts (a plain container kernel, an Ubuntu VM,
    // and Hetzner's DMI product_name which gVisor passes through into the sandbox).
    for (const s of [
      "Linux version 6.18.5 (builder@sandboxing) (gcc (GCC) 15.2.0)",
      "Linux version 6.8.0-51-generic (buildd@lcy02) #52-Ubuntu SMP",
      "vServer",
      // A real AWS EC2 host (captured from CloudShell): the DMI sys_vendor is "Amazon EC2"
      // and product_name an instance type. Amazon also OPERATES Firecracker, so this is the
      // vendor-name false positive worth guarding against explicitly.
      "Linux version 6.1.175-219.359.amzn2023.x86_64 (mockbuild@ip-10-0-172-126)",
      "Amazon EC2",
      "c5a.large",
    ]) {
      assert.equal(detectGvisorMarker(s), false, `false positive on: ${s}`);
      assert.equal(detectFirecrackerMarker(s), false, `false positive on: ${s}`);
    }
  });
});

describe("cgroupHasGvisorJobController", () => {
  it("detects gVisor's synthetic `job` controller (second independent signal)", () => {
    // Real /proc/self/cgroup from inside runsc release-20260721.0.
    assert.equal(cgroupHasGvisorJobController("7:pids:/\n6:memory:/\n5:job:/\n"), true);
  });

  it("does not fire on a real Linux cgroup list, incl. a path segment named job", () => {
    assert.equal(cgroupHasGvisorJobController("7:pids:/\n6:blkio:/\n"), false);
    assert.equal(cgroupHasGvisorJobController("0::/user.slice/job/task"), false);
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
  it("a live gVisor sandbox reports Seccomp: 0 — the gvisor check MUST precede the seccomp check", () => {
    // The real capture inside runsc showed `Seccomp: 0` and NO NoNewPrivs line at all. If the
    // seccomp/container branches were evaluated first, a genuine gVisor sandbox would resolve to
    // mechanism "none" (contained: false) — a false negative on the strongest sandbox there is.
    // This locks the ordering that prevents it.
    const v = detectContainment({
      gvisorMarker: true,
      seccompMode: 0,
      noNewPrivs: undefined,
      cgroupContainer: false,
    });
    assert.equal(v.mechanism, "gvisor");
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

describe("containmentPostureStatus: the kernel boundary in doctor's message", () => {
  it("WARNS for a VM guest with a gate wired, and says why it is not counted as containment", () => {
    const vm = detectContainment({ hypervisor: true, seccompMode: 0 });
    const r = containmentPostureStatus(vm, true);
    assert.equal(r.status, "warn");
    assert.match(r.detail, /VM guest/);
    assert.match(r.detail, /not counted as containment/);
  });
  it("names the shared kernel when a container passes", () => {
    const r = containmentPostureStatus(
      detectContainment({ dockerEnv: true, seccompMode: 2 }),
      true,
    );
    assert.equal(r.status, "pass");
    assert.match(r.detail, /kernel privilege escalation reaches the host/);
  });
});

/**
 * A local kernel privilege escalation crosses a shared kernel. OpenAI's "A thousand fewer paths to
 * root" (2026-11) reported 948 working kernel LPE exploits from one run on a stock distribution
 * kernel, so the verdict says which kind of boundary it found, apart from how sure the detection is.
 * Measured before this change, inside a Firecracker microVM (`/proc/version` "6.18.44-fc-v236", no
 * DMI, `hypervisor` CPU flag): `{"mechanism":"none","contained":false,"confidence":"high"}`.
 */
describe("detectContainment: the kernel boundary", () => {
  it("a container or seccomp shares the kernel, however sure the detection is", () => {
    const container = detectContainment({ dockerEnv: true, seccompMode: 2 });
    assert.equal(container.confidence, "high");
    assert.equal(container.kernel, "shared-kernel");
    assert.match(container.details.join(";"), /reaches the host/);
    assert.equal(detectContainment({ seccompMode: 2 }).kernel, "shared-kernel");
  });

  it("gVisor and Firecracker are a separate kernel", () => {
    assert.equal(detectContainment({ gvisorMarker: true }).kernel, "separate-kernel");
    assert.equal(detectContainment({ firecrackerMarker: true }).kernel, "separate-kernel");
  });

  it("a VM guest is a separate kernel but not counted as containment", () => {
    const v = detectContainment({ hypervisor: true, seccompMode: 0, dockerEnv: false });
    assert.equal(v.mechanism, "vm");
    assert.equal(v.contained, false);
    assert.equal(v.kernel, "separate-kernel");
    assert.equal(v.confidence, "heuristic");
    assert.match(v.details.join(";"), /workstation VM look the same from inside/);
  });

  it("a container inside a VM is still a container: the kernel it shares is the guest's", () => {
    const v = detectContainment({ hypervisor: true, cgroupContainer: true, seccompMode: 2 });
    assert.equal(v.mechanism, "container");
    assert.equal(v.kernel, "shared-kernel");
    assert.match(v.details.join(";"), /VM guest/);
  });

  it("'none' is high confidence only when a flags line was read without `hypervisor`", () => {
    assert.equal(detectContainment({ seccompMode: 0, hypervisor: false }).confidence, "high");
    const arm = detectContainment({ seccompMode: 0 });
    assert.equal(arm.confidence, "heuristic");
    assert.match(arm.details.join(";"), /not visible on this CPU architecture/);
  });

  it("unknown stays unknown", () => {
    assert.equal(detectContainment({ unreadable: true }).kernel, "unknown");
  });
});

describe("parseCpuHypervisor", () => {
  it("reads the x86 flags line, and says nothing without one", () => {
    assert.equal(
      parseCpuHypervisor("processor\t: 0\nflags\t\t: fpu vme sse2 hypervisor lahf_lm\n"),
      true,
    );
    assert.equal(parseCpuHypervisor("flags\t\t: fpu vme sse2 lahf_lm\n"), false);
    assert.equal(parseCpuHypervisor("Features\t: fp asimd evtstrm\n"), undefined);
    assert.equal(parseCpuHypervisor(""), undefined);
  });

  it("matches this machine: a guest whose cpuinfo has the flag reads as one", (t) => {
    let cpuinfo: string;
    try {
      cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
    } catch {
      return t.skip("no /proc/cpuinfo on this platform");
    }
    if (parseCpuHypervisor(cpuinfo) !== true) return t.skip("not running as an x86 VM guest");
    assert.equal(gatherContainmentSignals().hypervisor, true);
  });
});

describe("containmentEnforcement: the kernel boundary", () => {
  it("names a shared kernel when a container satisfies the policy", () => {
    const r = containmentEnforcement(detectContainment({ dockerEnv: true, seccompMode: 2 }), true);
    assert.equal(r.status, "pass");
    assert.match(r.detail, /shares the host kernel/);
  });

  it("a separate kernel is described as stronger, not absolute", () => {
    const r = containmentEnforcement(detectContainment({ gvisorMarker: true }), true);
    assert.match(r.detail, /separate kernel: stronger .* not absolute/);
  });

  it("fails a required policy inside a VM guest, and says why", () => {
    const r = containmentEnforcement(detectContainment({ hypervisor: true }), true);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /cannot tell a dedicated sandbox VM from a workstation VM/);
  });
});
