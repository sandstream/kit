/**
 * The rig's report (ADR-0007): arithmetic over adjudicated runs, nothing more.
 *
 * Per config, and separately for the `tune` and `holdout` halves of the manifest:
 *  - recall per run (caught / the manifest's defects in that half), as mean, min and max. A run
 *    counts for a half once it has a row for any defect in it; a defect it has no row for, or a
 *    `"failed"` row, is not caught, and the report names each one (`shortfall`). Dividing by the
 *    defects reviewed instead let a run that failed or skipped the hard targets score 100%;
 *  - the false-positive rate per run (controls flagged / the manifest's controls), where a control
 *    the run failed on or has no row for is counted as flagged, never as clean, and named the same way;
 *  - how often each defect was caught across runs;
 *  - how many findings each run produced, and how many matched no defect. Unmatched findings on a
 *    defect target are not false positives, so volume (flag every changed line) would raise
 *    recall at no visible cost; only controls price it. The count makes it visible either way.
 *
 * Comparing two configs is deliberately blunt and deterministic: a difference is called
 * "outside run-to-run spread" only when their [min, max] recall ranges do not overlap, and the
 * comparison is refused below three runs per config. No statistics the reader has to trust.
 * Recall alone cannot tell a reviewer that flags everything from one that flags the defect, so
 * when two configs' findings per run differ by ten times or more, the comparison says so instead
 * of calling them "within spread". That is a count, not a judgement of either reviewer.
 */
import type { RunOutcome } from "./adjudicate.js";
import type { RigManifest, Split } from "./manifest.js";

/** ADR-0007's three limits, printed with every report. */
export const LIMITS = [
  "Lower bound only: it measures only what was seeded. Defects nobody thought to plant are invisible; this is a floor on risk, never a safety score.",
  "Goodhart: the corpus becomes what gets optimised against. It must rotate and must never be published as a benchmark.",
  "Transfer is unproven: a number for one repository and corpus does not carry to another.",
] as const;

const MIN_RUNS_TO_COMPARE = 3;

/** From this ratio of mean findings per run (an order of magnitude), recall alone is not a comparison. */
export const VOLUME_RATIO_LIMIT = 10;

/**
 * A loop that proposes several candidates per round and keeps the one with the best holdout score
 * (a self-improving harness, a prompt sweep) turns the holdout into a training signal. From this
 * many configs on one holdout, the report says so. Two configs is the ordinary A/B the rig is for.
 */
const HOLDOUT_SPENT_AT = 3;

export interface Spread {
  mean: number;
  min: number;
  max: number;
}

/** The targets one run did not review: the ones it failed on, and the ones it has no row for. */
export interface Shortfall {
  run: string;
  /** Targets the run reviewed, out of `of` in the manifest. */
  reviewed: number;
  of: number;
  failed: { target: string; reason: string }[];
  missing: string[];
}

export interface SplitStats {
  runs: number;
  recall: Spread | null;
  falsePositiveRate: Spread | null;
  /** defect id → runs that caught it / runs that reviewed it */
  perDefect: Record<string, { caught: number; reviewed: number }>;
  /**
   * Runs that did not review every defect in this half; each missing one counted as not caught.
   * Absent in a result.json written before it existed.
   */
  shortfall?: Shortfall[];
}

export interface ConfigStats {
  config: string;
  tune: SplitStats;
  holdout: SplitStats;
  /** Clean-control runs are not split: a control belongs to neither half. */
  controls: { runs: number; falsePositiveRate: Spread | null; shortfall?: Shortfall[] };
  /** Findings per run (all targets), and findings on defect targets that matched no defect. */
  volume?: {
    findingsPerRun: Spread | null;
    unmatched: number;
    /** Further findings on a defect already caught in that run. Absent in older results. */
    duplicatesPerRun?: Spread | null;
    /** Per run: defects caught / findings produced. Null when no run produced a finding. */
    precision?: Spread | null;
  };
}

export type Comparison =
  | { verdict: "refused"; reason: string }
  | { verdict: "outside spread" | "within spread"; a: Spread; b: Spread; volumeRatio?: number };

export function spread(values: number[]): Spread | null {
  if (values.length === 0) return null;
  const sum = values.reduce((s, v) => s + v, 0);
  return { mean: sum / values.length, min: Math.min(...values), max: Math.max(...values) };
}

function groupByRun(outcomes: RunOutcome[]): Map<string, RunOutcome[]> {
  const runs = new Map<string, RunOutcome[]>();
  for (const o of outcomes) runs.set(o.run, [...(runs.get(o.run) ?? []), o]);
  return runs;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Which of `ids` one run reviewed, failed on, or has no row for. */
function shortfallOf(run: string, runOutcomes: RunOutcome[], ids: string[]): Shortfall | null {
  const failed = runOutcomes
    .filter((o) => o.failed !== undefined)
    .map((o) => ({ target: o.target, reason: o.failed as string }))
    .sort((a, b) => byId(a.target, b.target));
  const seen = new Set(runOutcomes.map((o) => o.target));
  const missing = ids.filter((id) => !seen.has(id));
  if (failed.length === 0 && missing.length === 0) return null;
  const reviewed = ids.length - failed.length - missing.length;
  return { run, reviewed, of: ids.length, failed, missing };
}

/** Count one run's reviewed defect outcomes into the per-defect tally; returns how many it caught. */
function tally(runOutcomes: RunOutcome[], perDefect: SplitStats["perDefect"]): number {
  let caught = 0;
  for (const o of runOutcomes) {
    if (o.failed !== undefined) continue;
    for (const id of [...o.caught, ...o.missed]) {
      const entry = (perDefect[id] ??= { caught: 0, reviewed: 0 });
      entry.reviewed++;
      if (o.caught.includes(id)) {
        entry.caught++;
        caught++;
      }
    }
  }
  return caught;
}

function splitStats(outcomes: RunOutcome[], manifest: RigManifest, split: Split): SplitStats {
  const ids = manifest.defects
    .filter((d) => d.split === split)
    .map((d) => d.id)
    .sort(byId);
  const inSplit = new Set(ids);
  const mine = outcomes.filter((o) => o.targetKind === "defect" && inSplit.has(o.target));
  const perDefect: SplitStats["perDefect"] = {};
  const recalls: number[] = [];
  const shortfall: Shortfall[] = [];
  for (const [run, runOutcomes] of [...groupByRun(mine)].sort(([a], [b]) => byId(a, b))) {
    recalls.push(tally(runOutcomes, perDefect) / ids.length);
    const short = shortfallOf(run, runOutcomes, ids);
    if (short) shortfall.push(short);
  }
  const sorted = Object.fromEntries(Object.entries(perDefect).sort(([a], [b]) => byId(a, b)));
  return {
    runs: recalls.length,
    recall: spread(recalls),
    falsePositiveRate: null,
    perDefect: sorted,
    shortfall,
  };
}

function controlStats(outcomes: RunOutcome[], manifest: RigManifest): ConfigStats["controls"] {
  const ids = manifest.controls.map((c) => c.id).sort(byId);
  const known = new Set(ids);
  const mine = outcomes.filter((o) => o.targetKind === "control" && known.has(o.target));
  const rates: number[] = [];
  const shortfall: Shortfall[] = [];
  for (const [run, runOutcomes] of [...groupByRun(mine)].sort(([a], [b]) => byId(a, b))) {
    const short = shortfallOf(run, runOutcomes, ids);
    const flagged = runOutcomes.filter((o) => o.failed === undefined && o.falsePositives > 0);
    const unreviewed = short ? short.failed.length + short.missing.length : 0;
    rates.push((flagged.length + unreviewed) / ids.length);
    if (short) shortfall.push(short);
  }
  return { runs: rates.length, falsePositiveRate: spread(rates), shortfall };
}

/** Every finding a run produced: caught, duplicates, unmatched, and false positives on controls. */
function volumeStats(outcomes: RunOutcome[]): NonNullable<ConfigStats["volume"]> {
  const perRun: number[] = [];
  const duplicates: number[] = [];
  const precision: number[] = [];
  for (const runOutcomes of groupByRun(outcomes).values()) {
    let findings = 0;
    let caught = 0;
    let repeated = 0;
    for (const o of runOutcomes) {
      caught += o.caught.length;
      repeated += o.duplicates;
      findings += o.caught.length + o.duplicates + o.unmatched + o.falsePositives;
    }
    perRun.push(findings);
    duplicates.push(repeated);
    if (findings > 0) precision.push(caught / findings);
  }
  const unmatched = outcomes.reduce((n, o) => n + o.unmatched, 0);
  return {
    findingsPerRun: spread(perRun),
    unmatched,
    duplicatesPerRun: spread(duplicates),
    precision: spread(precision),
  };
}

/** Aggregate adjudicated runs per config. Configs and defects come out sorted. */
export function aggregate(manifest: RigManifest, outcomes: RunOutcome[]): ConfigStats[] {
  const configs = [...new Set(outcomes.map((o) => o.config))].sort();
  return configs.map((config) => {
    const mine = outcomes.filter((o) => o.config === config);
    return {
      config,
      tune: splitStats(mine, manifest, "tune"),
      holdout: splitStats(mine, manifest, "holdout"),
      controls: controlStats(mine, manifest),
      volume: volumeStats(mine),
    };
  });
}

/** Compare two configs' recall on one split by the overlap rule. */
export function compare(a: SplitStats, b: SplitStats): Comparison {
  if (a.runs < MIN_RUNS_TO_COMPARE || b.runs < MIN_RUNS_TO_COMPARE || !a.recall || !b.recall) {
    return {
      verdict: "refused",
      reason: `each config needs at least ${MIN_RUNS_TO_COMPARE} runs (have ${a.runs} and ${b.runs})`,
    };
  }
  const apart = a.recall.max < b.recall.min || b.recall.max < a.recall.min;
  return { verdict: apart ? "outside spread" : "within spread", a: a.recall, b: b.recall };
}

/**
 * How many times more findings per run one config produced than the other, when that is at least
 * {@link VOLUME_RATIO_LIMIT}. A config with no findings counts as one, so the ratio stays finite.
 */
function volumeRatio(a: ConfigStats, b: ConfigStats): number | undefined {
  const x = a.volume?.findingsPerRun?.mean;
  const y = b.volume?.findingsPerRun?.mean;
  if (x === undefined || y === undefined) return undefined;
  const ratio = Math.max(x, y) / Math.max(Math.min(x, y), 1);
  return ratio >= VOLUME_RATIO_LIMIT ? ratio : undefined;
}

/** {@link compare} on one split, carrying the volume ratio when it is an order of magnitude. */
export function compareConfigs(a: ConfigStats, b: ConfigStats, split: Split): Comparison {
  const c = compare(a[split], b[split]);
  if (c.verdict === "refused") return c;
  const ratio = volumeRatio(a, b);
  return ratio === undefined ? c : { ...c, volumeRatio: ratio };
}

/**
 * Warnings about how the split was used. A config measured only on `tune` has numbers fitted
 * to the set it was tuned on; inputs that changed between runs are reported by the caller,
 * which knows the input ids.
 */
export function splitWarnings(stats: ConfigStats[]): string[] {
  const out: string[] = [];
  for (const s of stats) {
    if (s.tune.runs > 0 && s.holdout.runs === 0) {
      out.push(
        `config ${s.config}: only tune defects were run; its numbers are fitted to the tuning set`,
      );
    }
    if (s.controls.runs === 0) {
      out.push(`config ${s.config}: no control runs, so false positives are unmeasured`);
    }
  }
  const onHoldout = stats.filter((s) => s.holdout.runs > 0).length;
  if (onHoldout >= HOLDOUT_SPENT_AT) {
    out.push(
      `${onHoldout} configs were scored on the same holdout: choosing among them by holdout recall makes the holdout part of the selection, so the chosen config's holdout number is optimistic. Plant fresh holdout defects before the next comparison.`,
    );
  }
  return out;
}
