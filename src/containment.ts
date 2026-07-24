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

export type ContainmentMechanism = "container" | "seccomp" | "none" | "unknown";

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
  return signals;
}

function readSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
