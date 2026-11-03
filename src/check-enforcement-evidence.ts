/**
 * `enforcement evidence`: what kit can show about the gates beyond "configured".
 *
 * `enforcement gate liveness` answers whether the PreToolUse gates are wired. That is a belief about
 * a settings file, and a model can go round a gate that was only ever configured. This row joins
 * three facts and never reads "pass" from configuration alone:
 *
 *   - wired:    the install gate and the env-write gate are in the settings (liveness).
 *   - refuses:  the negative controls of `kit usage prove` held recently: kit's own gate code
 *               refuses what it must refuse and allows what it must allow. The result is kept for
 *               24 hours per kit version, and refreshed here when it is older.
 *   - bypassed: no commit skipped the pre-commit hook in the last 14 days (the existing skip log).
 *
 * Deliberately not run: the commands a settings file names. That file is repository content, so
 * executing its commands from `kit check` would run whatever a cloned repository wrote there. The
 * controls run kit's own build instead, and the row says what that leaves unproven.
 *
 * Not built yet: a record of what the gates allowed and blocked in real sessions (`recorded`).
 * Allowed calls are not logged today, and the gates are protected code.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { GateLiveness } from "./agent-config.js";
import type { SecurityCheckResult } from "./check-security.js";

export const EVIDENCE_CHECK = "enforcement evidence";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PROOF_MAX_AGE_MS = 24 * HOUR_MS;
const CLOCK_SKEW_MS = 5 * 60_000;
export const BYPASS_WINDOW_DAYS = 14;

/** The stored result of one run of the negative controls. No secret and no path: names and counts. */
export interface GateProof {
  version: string;
  /** ISO time the controls ran. */
  at: string;
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
  version: string;
  /** Why a stale proof was not refreshed. */
  refreshNote?: string;
}

const base = { category: "governance", name: EVIDENCE_CHECK } as const;

/** Printable ASCII only, one line: a log entry or a name from a file must not forge a verdict line. */
function plain(value: unknown, max = 80): string {
  return String(value)
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, max);
}

function proofAge(proof: GateProof, now: number): number | null {
  const at = Date.parse(proof.at);
  return Number.isNaN(at) ? null : now - at;
}

/** A proof counts when it is from this kit version, under 24 hours old and not from the future. */
export function proofIsFresh(proof: GateProof | null, now: number, version: string): boolean {
  if (!proof || proof.version !== version) return false;
  const age = proofAge(proof, now);
  return age !== null && age <= PROOF_MAX_AGE_MS && age >= -CLOCK_SKEW_MS;
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
  const p = f.proof;
  let why = "no gate proof has been made yet";
  if (p && p.version !== f.version) {
    why = `the last proof was made by kit ${plain(p.version, 20)}, this is ${plain(f.version, 20)}`;
  } else if (p) {
    const age = proofAge(p, f.now);
    why =
      age === null
        ? "the last proof has no readable time"
        : `the last proof is ${Math.floor(age / HOUR_MS)} hours old`;
  }
  const note = f.refreshNote ? ` (${plain(f.refreshNote, 120)})` : "";
  return {
    ...base,
    status: "warn",
    didNotRun: true,
    detail: `unverified: ${why}${note}. Run \`kit usage prove\` to produce one`,
  };
}

function ageText(proof: GateProof, now: number): string {
  const age = proofAge(proof, now) ?? 0;
  return age < HOUR_MS ? "under an hour ago" : `${Math.floor(age / HOUR_MS)} hours ago`;
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
  if (f.proof && proofIsFresh(f.proof, f.now, f.version) && f.proof.failed.length > 0) {
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
  if (!proofIsFresh(f.proof, f.now, f.version) || !f.proof) return unverified(f);
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
      `install gate and env-write gate wired; ${held} of ${f.proof.total} negative controls held ` +
      `${ageText(f.proof, f.now)}; no skipped hook in the last ${BYPASS_WINDOW_DAYS} days. ` +
      `Not proven: that another tool than Claude Code is gated, or that the settings file was not edited after the proof`,
  };
}

/** The stored proof, or null for a missing, unreadable or malformed file. */
export function readProofFile(file: string): GateProof | null {
  try {
    const text = readFileSync(file, "utf8");
    const v = JSON.parse(text) as Partial<GateProof>;
    const ok =
      typeof v.version === "string" &&
      typeof v.at === "string" &&
      typeof v.total === "number" &&
      Array.isArray(v.failed) &&
      v.failed.every((n) => typeof n === "string");
    return ok ? (v as GateProof) : null;
  } catch {
    return null;
  }
}

export function writeProofFile(file: string, proof: GateProof): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
}

export interface EvidenceDeps {
  now: () => number;
  version: string;
  liveness: (root: string) => EvidenceFacts["liveness"];
  readProof: () => GateProof | null;
  writeProof: (proof: GateProof) => void;
  /** Run the negative controls. */
  prove: (root: string) => { total: number; failed: string[] };
  /** False where running processes and writing the proof is not allowed (read-only mode). */
  canRun: () => boolean;
  skipped: (root: string) => Promise<{ entries: BypassEntry[] }>;
}

async function defaultDeps(): Promise<EvidenceDeps> {
  const { gateLiveness } = await import("./agent-config.js");
  const { proveFloor } = await import("./usage-prove.js");
  const { isReadOnlyMode } = await import("./read-only-mode.js");
  const { getKitVersionSync } = await import("./update-check.js");
  const file = join(homedir(), ".kit", "gate-proof.json");
  return {
    now: () => Date.now(),
    version: getKitVersionSync(),
    liveness: (root) => gateLiveness(root),
    readProof: () => readProofFile(file),
    writeProof: (proof) => writeProofFile(file, proof),
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

/** The evidence row for a checkout. Refreshes the stored proof when it is stale, never throws. */
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
  const now = d.now();
  let proof = wired ? d.readProof() : null;
  let refreshNote: string | undefined;
  if (wired && !proofIsFresh(proof, now, d.version)) {
    if (!d.canRun()) {
      refreshNote = "read-only mode: the controls were not run";
    } else {
      try {
        const ran = d.prove(root);
        proof = {
          version: d.version,
          at: new Date(now).toISOString(),
          total: ran.total,
          failed: ran.failed,
        };
        d.writeProof(proof);
      } catch (err) {
        refreshNote = `the controls could not run: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }
  const bypass = wired ? await d.skipped(root).catch(() => ({ entries: [] })) : { entries: [] };
  return judgeEvidence({ liveness, proof, bypass, now, version: d.version, refreshNote });
}
