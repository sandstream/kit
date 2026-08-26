/**
 * Run-to-run scan diff — what changed between two `kit check --json` documents.
 *
 * A baseline answers "which findings do I already know about"; it cannot answer "what
 * changed since Tuesday". Freezing suppresses, it does not compare. This does the
 * comparison, as a pure function of two documents so it is trivially reproducible: same
 * two files in, same diff out, no clock and no I/O.
 *
 * The reason this is not a generic differ: a naive diff reads `fail → skip` as "no longer
 * failing" and calls it an improvement. It is the opposite — the check stopped running, so
 * the finding is now *unknown*, not fixed. That is the false-green direction, and it is the
 * failure this tool exists to make visible. Coverage change is therefore a FIRST-CLASS
 * bucket, ranked above finding changes, and a check that could not run (`didNotRun`) is
 * treated as lost coverage even when its status reads `skip`.
 *
 * Borrowed shape: OpenAI Codex Security's `scans compare BEFORE AFTER`. The coverage axis is kit's.
 */
import type { JsonCheck, JsonCheckOutput } from "./cli-checks-shared.js";

/** Stable identity of a check across runs. Deliberately the SAME key `findings-track.ts`
 *  uses for PAL dedup, so "what changed" and "what is tracked" cannot disagree. */
export function checkKey(c: Pick<JsonCheck, "category" | "name">): string {
  return `${c.category}:${c.name}`;
}

/**
 * How a check's outcome moved. Ordered worst → best for reporting; `coverage-lost` sits
 * above `regressed` because an unknown is worse than a known failure.
 */
export type ScanChangeKind =
  | "coverage-lost" // ran before, does not run now (or now didNotRun) — the finding is UNKNOWN
  | "disappeared" // present before, absent from the after document entirely
  | "regressed" // still ran, outcome got worse
  | "appeared" // a check that did not exist before, and it is not passing
  | "coverage-gained" // did not run before, runs now
  | "improved" // still ran, outcome got better
  | "resolved" // was failing/warning, now passes
  | "unchanged";

export interface ScanChange {
  key: string;
  category: string;
  name: string;
  kind: ScanChangeKind;
  before?: { status: JsonCheck["status"]; severity?: JsonCheck["severity"]; didNotRun?: boolean };
  after?: { status: JsonCheck["status"]; severity?: JsonCheck["severity"]; didNotRun?: boolean };
  /** Set when severity moved while the check kept running. */
  severityChanged?: { from?: JsonCheck["severity"]; to?: JsonCheck["severity"] };
  /** One line, deterministic, safe to print or to put in a commit message. */
  summary: string;
}

export interface ScanDiff {
  changes: ScanChange[];
  counts: Record<ScanChangeKind, number>;
  /**
   * True when nothing moved in a direction a reviewer must look at. NOTE: this is not
   * "the after run is green" — a diff can be clean while both runs fail identically.
   */
  clean: boolean;
  /** Coverage lost or a regression appeared — the two things that must never pass silently. */
  worseThanBefore: boolean;
}

/** Ranks a status by how much it tells you. Higher = worse outcome, for RAN checks only. */
const OUTCOME_RANK: Record<JsonCheck["status"], number> = { pass: 0, warn: 1, fail: 2, skip: -1 };

/** A check "ran" when it produced a real verdict. `skip` did not run; `didNotRun` lied about it. */
export function didRun(c: Pick<JsonCheck, "status"> & { didNotRun?: boolean }): boolean {
  if (c.didNotRun === true) return false;
  return c.status !== "skip";
}

const SEVERITY_RANK: Record<NonNullable<JsonCheck["severity"]>, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function severityMoved(
  a: JsonCheck["severity"],
  b: JsonCheck["severity"],
): { from?: JsonCheck["severity"]; to?: JsonCheck["severity"] } | undefined {
  if (a === b) return undefined;
  return { from: a, to: b };
}

function side(c: JsonCheck): NonNullable<ScanChange["before"]> {
  return { status: c.status, severity: c.severity, didNotRun: c.didNotRun };
}

/** Classify one check's movement. Pure; `before`/`after` may each be absent. */
export function classifyChange(
  before: JsonCheck | undefined,
  after: JsonCheck | undefined,
): ScanChangeKind {
  if (before && !after) return "disappeared";
  if (!before && after) return after.status === "pass" ? "coverage-gained" : "appeared";
  if (!before || !after) return "unchanged"; // unreachable; keeps the function total
  const ranBefore = didRun(before);
  const ranAfter = didRun(after);
  // Coverage first: whether the check RAN dominates what it said.
  if (ranBefore && !ranAfter) return "coverage-lost";
  if (!ranBefore && ranAfter) return "coverage-gained";
  if (!ranBefore && !ranAfter) return "unchanged";
  const d = OUTCOME_RANK[after.status] - OUTCOME_RANK[before.status];
  if (d > 0) return "regressed";
  if (d < 0) return after.status === "pass" ? "resolved" : "improved";
  // Same status, but severity can still move (e.g. a high CVE becomes critical).
  const sev = (SEVERITY_RANK[after.severity!] ?? 0) - (SEVERITY_RANK[before.severity!] ?? 0);
  if (sev > 0) return "regressed";
  if (sev < 0) return "improved";
  return "unchanged";
}

function describe(kind: ScanChangeKind, key: string, b?: JsonCheck, a?: JsonCheck): string {
  const sev = (c?: JsonCheck) => (c?.severity ? ` [${c.severity}]` : "");
  switch (kind) {
    case "coverage-lost":
      return `${key}: ran before (${b!.status}${sev(b)}), does NOT run now (${a!.status}${a!.didNotRun ? ", could not run" : ""}) — the finding is unknown, not fixed`;
    case "disappeared":
      return `${key}: present before (${b!.status}${sev(b)}), absent from the second run entirely — check removed or not executed`;
    case "regressed":
      return `${key}: ${b!.status}${sev(b)} → ${a!.status}${sev(a)}`;
    case "appeared":
      return `${key}: new check, ${a!.status}${sev(a)}`;
    case "coverage-gained":
      return b
        ? `${key}: did not run before, now ${a!.status}${sev(a)}`
        : `${key}: new check, passing`;
    case "improved":
      return `${key}: ${b!.status}${sev(b)} → ${a!.status}${sev(a)}`;
    case "resolved":
      return `${key}: ${b!.status}${sev(b)} → pass`;
    case "unchanged":
      return `${key}: unchanged (${a!.status}${sev(a)})`;
  }
}

/** Report order: worst first, then by key so the output is byte-stable across runs. */
const KIND_ORDER: ScanChangeKind[] = [
  "coverage-lost",
  "disappeared",
  "regressed",
  "appeared",
  "coverage-gained",
  "improved",
  "resolved",
  "unchanged",
];

/**
 * Diff two `kit check --json` documents. Pure: no clock, no filesystem, no network — the
 * same two documents always produce the same diff, which is what makes it usable in a gate.
 */
export function diffScans(before: JsonCheckOutput, after: JsonCheckOutput): ScanDiff {
  const b = new Map((before.checks ?? []).map((c) => [checkKey(c), c] as const));
  const a = new Map((after.checks ?? []).map((c) => [checkKey(c), c] as const));
  const keys = [...new Set([...b.keys(), ...a.keys()])];

  const changes: ScanChange[] = keys.map((key) => {
    const bc = b.get(key);
    const ac = a.get(key);
    const kind = classifyChange(bc, ac);
    const ran = bc && ac && didRun(bc) && didRun(ac);
    return {
      key,
      category: (ac ?? bc)!.category,
      name: (ac ?? bc)!.name,
      kind,
      before: bc ? side(bc) : undefined,
      after: ac ? side(ac) : undefined,
      severityChanged: ran ? severityMoved(bc.severity, ac.severity) : undefined,
      summary: describe(kind, key, bc, ac),
    };
  });

  changes.sort(
    (x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.key.localeCompare(y.key),
  );

  const counts = Object.fromEntries(KIND_ORDER.map((k) => [k, 0])) as Record<
    ScanChangeKind,
    number
  >;
  for (const c of changes) counts[c.kind]++;

  const worseThanBefore =
    counts["coverage-lost"] > 0 || counts.disappeared > 0 || counts.regressed > 0;
  return {
    changes,
    counts,
    // "appeared" counts as needing a look: a brand-new non-passing check is news.
    clean: !worseThanBefore && counts.appeared === 0,
    worseThanBefore,
  };
}
