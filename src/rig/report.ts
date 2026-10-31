/**
 * The rig's report (ADR-0007): arithmetic over adjudicated runs, nothing more.
 *
 * Per config, and separately for the `tune` and `holdout` halves of the manifest:
 *  - recall per run (caught / defects reviewed in that run), as mean, min and max;
 *  - the false-positive rate per run (clean controls with any finding / controls reviewed);
 *  - how often each defect was caught across runs.
 *
 * Comparing two configs is deliberately blunt and deterministic: a difference is called
 * "outside run-to-run spread" only when their [min, max] recall ranges do not overlap, and the
 * comparison is refused below three runs per config. No statistics the reader has to trust.
 */
import type { RunOutcome } from "./adjudicate.js";
import type { RigManifest, Split } from "./manifest.js";

/** ADR-0007's three limits, printed with every report. */
export const LIMITS = [
  "Lower bound only: it measures only what was seeded. Defects nobody thought to plant are invisible; this is a floor on risk, never a safety score.",
  "Goodhart: the corpus becomes what gets optimised against. It must rotate and must never be published as a benchmark.",
  "Transfer is unproven: a number for one repository and corpus does not carry to another.",
] as const;

export const MIN_RUNS_TO_COMPARE = 3;

export interface Spread {
  mean: number;
  min: number;
  max: number;
}

export interface SplitStats {
  runs: number;
  recall: Spread | null;
  falsePositiveRate: Spread | null;
  /** defect id → runs that caught it / runs that reviewed it */
  perDefect: Record<string, { caught: number; reviewed: number }>;
}

export interface ConfigStats {
  config: string;
  tune: SplitStats;
  holdout: SplitStats;
  /** Clean-control runs are not split: a control belongs to neither half. */
  controls: { runs: number; falsePositiveRate: Spread | null };
}

export type Comparison =
  | { verdict: "refused"; reason: string }
  | { verdict: "outside spread" | "within spread"; a: Spread; b: Spread };

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

function splitStats(outcomes: RunOutcome[], splitOf: Map<string, Split>, split: Split): SplitStats {
  const mine = outcomes.filter((o) => o.targetKind === "defect" && splitOf.get(o.target) === split);
  const perDefect: SplitStats["perDefect"] = {};
  const recalls: number[] = [];
  for (const [, runOutcomes] of [...groupByRun(mine)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let caught = 0;
    let reviewed = 0;
    for (const o of runOutcomes) {
      for (const id of [...o.caught, ...o.missed]) {
        const entry = (perDefect[id] ??= { caught: 0, reviewed: 0 });
        entry.reviewed++;
        reviewed++;
        if (o.caught.includes(id)) {
          entry.caught++;
          caught++;
        }
      }
    }
    if (reviewed > 0) recalls.push(caught / reviewed);
  }
  const sorted = Object.fromEntries(Object.entries(perDefect).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    runs: recalls.length,
    recall: spread(recalls),
    falsePositiveRate: null,
    perDefect: sorted,
  };
}

function controlStats(outcomes: RunOutcome[]): ConfigStats["controls"] {
  const rates: number[] = [];
  for (const [, runOutcomes] of groupByRun(outcomes.filter((o) => o.targetKind === "control"))) {
    rates.push(runOutcomes.filter((o) => o.falsePositives > 0).length / runOutcomes.length);
  }
  return { runs: rates.length, falsePositiveRate: spread(rates) };
}

/** Aggregate adjudicated runs per config. Configs and defects come out sorted. */
export function aggregate(manifest: RigManifest, outcomes: RunOutcome[]): ConfigStats[] {
  const splitOf = new Map(manifest.defects.map((d) => [d.id, d.split]));
  const configs = [...new Set(outcomes.map((o) => o.config))].sort();
  return configs.map((config) => {
    const mine = outcomes.filter((o) => o.config === config);
    return {
      config,
      tune: splitStats(mine, splitOf, "tune"),
      holdout: splitStats(mine, splitOf, "holdout"),
      controls: controlStats(mine),
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
  return out;
}
