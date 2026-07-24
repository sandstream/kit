/**
 * kit — containment detection (the sandbox BELOW the tool boundary).
 *
 * kit governs the tool boundary (PreToolUse + signed scope); a real OS/network
 * sandbox contains what happens beneath it (the OpenAI eval-escape happened there).
 * kit must NOT become a sandbox — it DETECTS and VERIFIES one as a delegate, and
 * folds the fact into its posture. Deterministic, zero-LLM, read-only.
 *
 * Design: kit-research/docs/research/containment-delegate-design.md.
 *
 * Honest semantics: `contained: true` only on a positive signal; `unknown` when the
 * signals can't be read (non-Linux, restricted /proc) — never a false "not contained"
 * (absence of evidence is not evidence of absence).
 */
import { readFileSync, existsSync } from "node:fs";

export type ContainmentMechanism =
  | "gvisor"
  | "firecracker"
  | "container"
  | "seccomp"
  | "none"
  | "unknown";

/** Parsed, deterministic containment signals (all optional — unknown when unread). */
export interface ContainmentSignals {
  /** `/.dockerenv` (or equivalent) present. */
  dockerEnv?: boolean;
  /** cgroup text contained a container runtime marker (docker/containerd/kubepods/lxc/libpod). */
  cgroupContainer?: boolean;
  /** `/proc/self/status` Seccomp field: 0 disabled, 1 strict, 2 filter; undefined = unread. */
  seccompMode?: 0 | 1 | 2;
  /** `/proc/self/status` NoNewPrivs: true when 1. */
  noNewPrivs?: boolean;
  /** A non-identity `/proc/self/uid_map` ⇒ a user namespace is in effect. */
  userNamespace?: boolean;
  /**
   * A gVisor (runsc) fingerprint was positively matched in a userspace-visible string
   * (e.g. `/proc/version`). Absence is NOT evidence of no gVisor — these runtimes are
   * deliberately stealthy — so a false here never downgrades the verdict.
   */
  gvisorMarker?: boolean;
  /** A Firecracker microVM fingerprint was positively matched (DMI vendor / `/proc/version`). */
  firecrackerMarker?: boolean;
  /** The signal source could not be read at all (e.g. no /proc) ⇒ verdict is `unknown`. */
  unreadable?: boolean;
}

export interface ContainmentVerdict {
  mechanism: ContainmentMechanism;
  /** True only on a positive isolation signal. Never inferred from absence. */
  contained: boolean;
  confidence: "high" | "heuristic" | "none";
  details: string[];
}

/**
 * Pure verdict from parsed signals. `unknown` when nothing could be read; `none` when
 * readable but no isolation signal present; `container`/`seccomp` on a positive signal.
 */
export function detectContainment(s: ContainmentSignals): ContainmentVerdict {
  if (s.unreadable) {
    return {
      mechanism: "unknown",
      contained: false,
      confidence: "none",
      details: [
        "containment signals unreadable (non-Linux or restricted /proc) — cannot determine; not a 'not contained' verdict",
      ],
    };
  }

  const details: string[] = [];
  const seccompActive = s.seccompMode === 1 || s.seccompMode === 2;
  const container = s.dockerEnv === true || s.cgroupContainer === true;

  if (s.dockerEnv) details.push("container marker: /.dockerenv");
  if (s.cgroupContainer)
    details.push("container marker: cgroup runtime (docker/containerd/kubepods/…)");
  if (seccompActive)
    details.push(`seccomp active (mode ${s.seccompMode === 1 ? "strict" : "filter"})`);
  if (s.noNewPrivs) details.push("no_new_privs set (privilege escalation blocked)");
  if (s.userNamespace) details.push("user namespace in effect");

  // Sandboxed runtimes: a POSITIVE fingerprint names the mechanism precisely and is stronger
  // isolation than a plain container. It is `heuristic` because the fingerprint is a
  // userspace-visible string, not a cryptographic proof — but a positive is never a false green,
  // and we never *infer* these from absence (the runtimes are stealthy by design).
  if (s.gvisorMarker) {
    return {
      mechanism: "gvisor",
      contained: true,
      confidence: "heuristic",
      details: [...details, "gVisor (runsc) fingerprint matched — user-space kernel sandbox"],
    };
  }
  if (s.firecrackerMarker) {
    return {
      mechanism: "firecracker",
      contained: true,
      confidence: "heuristic",
      details: [...details, "Firecracker microVM fingerprint matched — KVM-isolated guest"],
    };
  }

  if (container) {
    // A container plus syscall filtering is meaningful isolation; a bare container is weaker.
    return {
      mechanism: "container",
      contained: true,
      confidence: seccompActive ? "high" : "heuristic",
      details,
    };
  }
  if (seccompActive) {
    return { mechanism: "seccomp", contained: true, confidence: "heuristic", details };
  }
  return {
    mechanism: "none",
    contained: false,
    confidence: "high",
    details: details.length ? details : ["no container / seccomp isolation signal found"],
  };
}

/** Parse the `Seccomp:` line of /proc/self/status content. undefined when absent. */
export function parseSeccompMode(statusContent: string): 0 | 1 | 2 | undefined {
  const m = statusContent.match(/^Seccomp:\s*(\d+)/m);
  if (!m) return undefined;
  const v = parseInt(m[1], 10);
  return v === 0 || v === 1 || v === 2 ? v : undefined;
}

/** Detect a container runtime marker in cgroup text. */
export function cgroupHasContainer(cgroupContent: string): boolean {
  return /\b(docker|containerd|kubepods|lxc|libpod)\b/.test(cgroupContent);
}

/**
 * gVisor (runsc) fingerprint from a userspace-visible string such as `/proc/version`.
 * gVisor exposes a synthetic /proc; some builds embed "gVisor"/"runsc" in the reported
 * kernel version. A match is a real positive; a non-match is inconclusive (never "not gVisor").
 */
export function detectGvisorMarker(text: string): boolean {
  return /\b(gvisor|runsc)\b/i.test(text);
}

/**
 * Firecracker microVM fingerprint from DMI vendor strings / `/proc/version`. Firecracker is
 * deliberately minimal (often no DMI at all), so this frequently returns false even inside one —
 * that is the honest outcome, not a "not contained" claim. Only a positive vendor/version string
 * is trusted.
 */
export function detectFirecrackerMarker(text: string): boolean {
  return /\bfirecracker\b/i.test(text);
}

/**
 * Fail-closed enforcement of a "containment required" policy. Pure. When containment is required
 * but cannot be positively established — including the `unknown` (unreadable) case — this FAILS:
 * a required control that cannot be proven present is treated as absent (no false green).
 */
export function containmentEnforcement(
  v: ContainmentVerdict,
  required: boolean,
): { status: "pass" | "fail" | "skip"; detail: string } {
  if (!required) {
    return { status: "skip", detail: "containment not required by policy (advisory posture only)" };
  }
  if (v.contained) {
    return {
      status: "pass",
      detail: `policy requires containment — satisfied by ${v.mechanism} (${v.confidence})`,
    };
  }
  if (v.mechanism === "unknown") {
    return {
      status: "fail",
      detail:
        "policy requires containment, but it cannot be determined (non-Linux / restricted /proc) — a required control that cannot be proven present is treated as absent (fail-closed)",
    };
  }
  return {
    status: "fail",
    detail:
      "policy requires containment, but no container / seccomp / sandbox isolation was detected below the tool boundary",
  };
}

/**
 * Read the deterministic containment signals from the host (Linux /proc). Best-effort:
 * anything unreadable is left undefined; a total absence of /proc yields `unreadable`.
 * Impure but never throws.
 */
export function gatherContainmentSignals(): ContainmentSignals {
  // No /proc (macOS/Windows) → we genuinely cannot tell. Honest `unreadable`.
  if (!existsSync("/proc/self/status")) return { unreadable: true };

  const signals: ContainmentSignals = {};
  try {
    signals.dockerEnv = existsSync("/.dockerenv");
  } catch {
    /* best-effort */
  }
  try {
    const cg = readSafe("/proc/self/cgroup") + "\n" + readSafe("/proc/1/cgroup");
    if (cg.trim()) signals.cgroupContainer = cgroupHasContainer(cg);
  } catch {
    /* best-effort */
  }
  try {
    const status = readSafe("/proc/self/status");
    if (status) {
      signals.seccompMode = parseSeccompMode(status);
      const nnp = status.match(/^NoNewPrivs:\s*(\d+)/m);
      if (nnp) signals.noNewPrivs = nnp[1] === "1";
    }
  } catch {
    /* best-effort */
  }
  try {
    const uidMap = readSafe("/proc/self/uid_map").trim();
    // Identity map "         0          0 4294967295" ⇒ NOT a userns remap.
    if (uidMap) signals.userNamespace = !/^\s*0\s+0\s+4294967295\s*$/.test(uidMap);
  } catch {
    /* best-effort */
  }
  try {
    // Sandboxed-runtime fingerprints. Concatenate the userspace-visible strings a stealthy
    // runtime *might* leak into; a positive names the mechanism, an absence claims nothing.
    const procVersion = readSafe("/proc/version");
    const dmi = [
      readSafe("/sys/class/dmi/id/product_name"),
      readSafe("/sys/class/dmi/id/sys_vendor"),
      readSafe("/sys/class/dmi/id/bios_vendor"),
    ].join(" ");
    const haystack = `${procVersion} ${dmi}`;
    if (detectGvisorMarker(haystack)) signals.gvisorMarker = true;
    if (detectFirecrackerMarker(haystack)) signals.firecrackerMarker = true;
  } catch {
    /* best-effort */
  }
  return signals;
}

function readSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
