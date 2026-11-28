/**
 * Which instruments produced the runs (ADR-0007): the model, version and optional `model_digest`
 * each run declared, counted per config. This is bookkeeping over hand-in data. kit did not run
 * the model, so a digest is the caller's claim, recorded and shown, never verified and never
 * used to adjudicate a finding or to change a number.
 */
import type { RunMark } from "./findings.js";

export interface Instrument {
  config: string;
  model: string;
  model_version: string;
  /** Absent when the runs declared none. */
  model_digest?: string;
  /** Distinct runs of this config that declared exactly this instrument. */
  runs: number;
}

/** Printed whenever a digest is shown, so it never reads as proof. */
export const DIGEST_LIMIT =
  "model_digest is self-declared: kit did not run the model and cannot prove the findings came from those weights. It is recorded, never adjudicated on.";

const keyOf = (m: Pick<RunMark, "config" | "model" | "model_version" | "model_digest">): string =>
  JSON.stringify([m.config, m.model, m.model_version, m.model_digest ?? ""]);

/** One entry per (config, model, version, digest), sorted, with how many runs declared it. */
export function instrumentsOf(runs: RunMark[]): Instrument[] {
  const seen = new Map<string, { inst: Instrument; runIds: Set<string> }>();
  for (const r of runs) {
    const key = keyOf(r);
    let entry = seen.get(key);
    if (!entry) {
      const inst: Instrument = {
        config: r.config,
        model: r.model,
        model_version: r.model_version,
        runs: 0,
      };
      if (r.model_digest !== undefined) inst.model_digest = r.model_digest;
      entry = { inst, runIds: new Set() };
      seen.set(key, entry);
    }
    entry.runIds.add(r.run);
  }
  const out = [...seen.entries()].map(([key, e]) => ({
    key,
    inst: { ...e.inst, runs: e.runIds.size },
  }));
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out.map((e) => e.inst);
}

/**
 * A label that hides more than one instrument: one config's model and version declared with two
 * digests, or with a digest on some runs and none on others. Counted, never resolved.
 */
export function instrumentWarnings(instruments: Instrument[]): string[] {
  const byLabel = new Map<string, Instrument[]>();
  for (const i of instruments) {
    const label = JSON.stringify([i.config, i.model, i.model_version]);
    byLabel.set(label, [...(byLabel.get(label) ?? []), i]);
  }
  const out: string[] = [];
  for (const group of byLabel.values()) {
    const { config, model, model_version } = group[0];
    const digests = group.filter((i) => i.model_digest !== undefined);
    const bare = group.find((i) => i.model_digest === undefined);
    const label = `config ${config}: ${model} ${model_version}`;
    if (digests.length > 1) {
      out.push(
        `${label} was declared with ${digests.length} different model_digest values; its runs are different instruments under one label`,
      );
    } else if (digests.length === 1 && bare) {
      out.push(
        `${label} has ${bare.runs} run(s) with no model_digest beside runs declaring ${digests[0].model_digest}; they cannot be told apart`,
      );
    }
  }
  return out;
}
