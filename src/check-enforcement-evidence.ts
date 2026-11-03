/**
 * `enforcement evidence`: what kit can show about the gates beyond "configured".
 *
 * `enforcement gate liveness` answers whether the PreToolUse gates are wired. That is a belief about
 * a settings file, and a model can go round a gate that was only ever configured. This row joins
 * three facts and never reads "pass" from configuration alone:
 *
 *   - wired:    the install gate and the env-write gate are in the settings (liveness).
 *   - refuses:  the negative controls of `kit usage prove` held just now: kit's own gate code
 *               refuses what it must refuse and allows what it must allow. They run on every
 *               check (about two seconds) and the result is not stored. A stored result would be a
 *               claim in a file that the agent being checked can write, so it would prove nothing.
 *   - bypassed: no commit skipped the pre-commit hook in the last 14 days (the existing skip log).
 *
 * Deliberately not run: the commands a settings file names. That file is repository content, so
 * executing its commands from `kit check` would run whatever a cloned repository wrote there. The
 * controls run kit's own build instead, and the row says what that leaves unproven.
 *
 * Not built yet: a record of what the gates allowed and blocked in real sessions (`recorded`).
 * Allowed calls are not logged today, and the gates are protected code.
 */
import { resolve } from "node:path";

import type { GateLiveness } from "./agent-config.js";
import type { SecurityCheckResult } from "./check-security.js";

export const EVIDENCE_CHECK = "enforcement evidence";

const DAY_MS = 86_400_000;
export const BYPASS_WINDOW_DAYS = 14;

/** The result of one run of the negative controls: counts and names, nothing else. */
export interface GateProof {
  total: number;
  failed: string[];
}

export interface BypassEntry {
  timestamp: string;
  sha: string;
  reason: string;
}

export interface EvidenceFacts {
  liveness: Pick<GateLiveness, "installGate" | "envGate" | "everInstalled" | "problems">;
  proof: GateProof | null;
  bypass: { entries: BypassEntry[] };
  now: number;
  /** Why the controls did not run. */
  refreshNote?: string;
}

const base = { category: "governance", name: EVIDENCE_CHECK } as const;

/** Printable ASCII only, one line: a log entry or a name from a file must not forge a verdict line. */
function plain(value: unknown, max = 80): string {
  return String(value)
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, max);
}

function recentBypass(entries: BypassEntry[], now: number): BypassEntry[] {
  const since = now - BYPASS_WINDOW_DAYS * DAY_MS;
  // An entry whose time cannot be read stays counted: a bypass kit cannot date is not one it can dismiss.
  return entries.filter((e) => {
    const at = Date.parse(e.timestamp);
    return Number.isNaN(at) || at >= since;
  });
}

function unverified(f: EvidenceFacts): SecurityCheckResult {
  const note = f.refreshNote ? ` (${plain(f.refreshNote, 120)})` : "";
  return {
    ...base,
    status: "warn",
    didNotRun: true,
    detail: `unverified: the negative controls did not run${note}. Run \`kit usage prove\` to see them`,
  };
}

/** The verdict for one set of facts. Pure. */
export function judgeEvidence(f: EvidenceFacts): SecurityCheckResult {
  const l = f.liveness;
  if (!l.everInstalled || !l.installGate || !l.envGate || l.problems.length > 0) {
    return {
      ...base,
      status: "skip",
      detail:
        "the gates are not wired here, so there is nothing to prove: see enforcement gate liveness",
    };
  }
  if (f.proof && f.proof.failed.length > 0) {
    const names = f.proof.failed.map((n) => plain(n)).join("; ");
    return {
      ...base,
      status: "fail",
      severity: "high",
      hasFindings: true,
      detail: `${f.proof.failed.length} of ${f.proof.total} negative controls did not hold: ${names}`,
      suggestion:
        "Run `kit usage prove` to see what each control did, and fix the gate before relying on it.",
    };
  }
  if (!f.proof) return unverified(f);
  const skipped = recentBypass(f.bypass.entries, f.now);
  if (skipped.length > 0) {
    const last = skipped[skipped.length - 1];
    const sha = plain(last.sha, 200)
      .replace(/[^0-9a-f]/g, "")
      .slice(0, 8);
    return {
      ...base,
      status: "warn",
      severity: "medium",
      hasFindings: true,
      detail: `${skipped.length} commit(s) skipped the hook in the last ${BYPASS_WINDOW_DAYS} days, latest ${sha}; the gates themselves held (${f.proof.total} of ${f.proof.total} controls)`,
      suggestion: `Review the log: cat .kit-skipped-commits.jsonl | jq .`,
    };
  }
  const held = f.proof.total - f.proof.failed.length;
  return {
    ...base,
    status: "pass",
    detail:
      `install gate and env-write gate wired; ${held} of ${f.proof.total} negative controls held just now; ` +
      `no skipped hook in the last ${BYPASS_WINDOW_DAYS} days. ` +
      `Not proven: that another tool than Claude Code is gated, or that the settings file was not edited after the proof`,
  };
}

export interface EvidenceDeps {
  now: () => number;
  liveness: (root: string) => EvidenceFacts["liveness"];
  /** Run the negative controls. */
  prove: (root: string) => GateProof;
  /** False where running processes is not allowed (read-only mode). */
  canRun: () => boolean;
  skipped: (root: string) => Promise<{ entries: BypassEntry[] }>;
}

async function defaultDeps(): Promise<EvidenceDeps> {
  const { gateLiveness } = await import("./agent-config.js");
  const { proveFloor } = await import("./usage-prove.js");
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  return {
    now: () => Date.now(),
    liveness: (root) => gateLiveness(root),
    prove: (root) => {
      const r = proveFloor(root);
      return {
        total: r.controls.length,
        failed: r.controls.filter((c) => !c.ok).map((c) => c.name),
      };
    },
    canRun: () => !isReadOnlyMode(),
    skipped: readSkippedCommits,
  };
}

async function readSkippedCommits(root: string): Promise<{ entries: BypassEntry[] }> {
  const { SKIPPED_COMMITS_LOG } = await import("./hooks.js");
  const { readRegularFileIfPresent } = await import("./upstream-safe-read.js");
  const { parseSkippedCommits, partitionSkippedCommits, gitReachabilityProbe } =
    await import("./skipped-commits.js");
  const text = readRegularFileIfPresent(resolve(root, SKIPPED_COMMITS_LOG));
  if (text === null) return { entries: [] };
  // The same count as the banner: replays and commits that no ref contains are set aside.
  const { live } = partitionSkippedCommits(parseSkippedCommits(text), gitReachabilityProbe(root));
  return { entries: live };
}

/** The evidence row for a checkout. Runs the controls, never throws. */
export async function checkEnforcementEvidence(
  root: string,
  deps?: EvidenceDeps,
): Promise<SecurityCheckResult> {
  const d = deps ?? (await defaultDeps());
  const liveness = d.liveness(root);
  const wired =
    liveness.everInstalled &&
    liveness.installGate &&
    liveness.envGate &&
    liveness.problems.length === 0;
  let proof: GateProof | null = null;
  let refreshNote: string | undefined;
  if (wired && !d.canRun()) {
    refreshNote = "read-only mode: the controls were not run";
  } else if (wired) {
    try {
      proof = d.prove(root);
    } catch (err) {
      refreshNote = `the controls could not run: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const bypass = wired ? await d.skipped(root).catch(() => ({ entries: [] })) : { entries: [] };
  return judgeEvidence({ liveness, proof, bypass, now: d.now(), refreshNote });
}
