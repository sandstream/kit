/**
 * Deterministic adjudication for the rig (ADR-0007): the repository decides, never a model.
 *
 * A run reviewed one target from the manifest.
 *  - A **defect** target: a finding catches the planted defect when its file matches and its
 *    line lies within `[line_start - tolerance, line_end + tolerance]`. A defect is caught at
 *    most once per run; further findings on it are duplicates. A finding that could match two
 *    planted defects counts for the nearer one, and a tie goes to the lower id. A finding that
 *    matches nothing is **unmatched**: reported, but not a false positive, because it may be a
 *    real bug that was already in the code.
 *  - A **control** target (a clean diff): every finding is a **false positive**.
 *
 * Nothing here reads the claim text. Same input, same findings, same numbers.
 */
import type { Finding, IngestResult, RunMark } from "./findings.js";
import { runKey } from "./findings.js";
import type { RigDefect, RigManifest } from "./manifest.js";

export interface RunOutcome {
  config: string;
  run: string;
  target: string;
  targetKind: "defect" | "control";
  caught: string[];
  missed: string[];
  duplicates: number;
  falsePositives: number;
  unmatched: number;
}

export interface Adjudication {
  outcomes: RunOutcome[];
  /** Runs whose target is in neither the defects nor the controls: refused, not guessed. */
  unknownTargets: RunMark[];
}

/** Lines from the defect to the finding (0 inside the range), or null when it does not match. */
export function distance(
  f: Pick<Finding, "file" | "line">,
  d: RigDefect,
  tolerance: number,
): number | null {
  if (f.file !== d.file) return null;
  if (f.line < d.line_start - tolerance || f.line > d.line_end + tolerance) return null;
  if (f.line >= d.line_start && f.line <= d.line_end) return 0;
  return Math.min(Math.abs(f.line - d.line_start), Math.abs(f.line - d.line_end));
}

/** The planted defect a finding counts for: nearest first, then lowest id. Null for none. */
export function nearest(f: Finding, planted: RigDefect[], tolerance: number): RigDefect | null {
  let best: { d: RigDefect; dist: number } | null = null;
  for (const d of planted) {
    const dist = distance(f, d, tolerance);
    if (dist === null) continue;
    if (!best || dist < best.dist || (dist === best.dist && d.id < best.d.id)) best = { d, dist };
  }
  return best?.d ?? null;
}

/** Adjudicate one run against the defects it planted (or the control it reviewed). */
export function adjudicateRun(
  mark: RunMark,
  findings: Finding[],
  planted: RigDefect[],
  tolerance: number,
  targetKind: "defect" | "control",
): RunOutcome {
  const base = { config: mark.config, run: mark.run, target: mark.target, targetKind };
  if (targetKind === "control") {
    return {
      ...base,
      caught: [],
      missed: [],
      duplicates: 0,
      falsePositives: findings.length,
      unmatched: 0,
    };
  }
  const caught = new Set<string>();
  let duplicates = 0;
  let unmatched = 0;
  for (const f of findings) {
    const d = nearest(f, planted, tolerance);
    if (!d) unmatched++;
    else if (caught.has(d.id)) duplicates++;
    else caught.add(d.id);
  }
  const ids = planted.map((d) => d.id).sort();
  return {
    ...base,
    caught: ids.filter((id) => caught.has(id)),
    missed: ids.filter((id) => !caught.has(id)),
    duplicates,
    falsePositives: 0,
    unmatched,
  };
}

/** Adjudicate every run in an ingest against the manifest. Output is sorted and reproducible. */
export function adjudicate(manifest: RigManifest, ingest: IngestResult): Adjudication {
  const defects = new Map(manifest.defects.map((d) => [d.id, d]));
  const controls = new Set(manifest.controls.map((c) => c.id));
  const byRun = new Map<string, Finding[]>();
  for (const f of ingest.findings) {
    const k = runKey(f);
    byRun.set(k, [...(byRun.get(k) ?? []), f]);
  }
  const outcomes: RunOutcome[] = [];
  const unknownTargets: RunMark[] = [];
  for (const mark of ingest.runs) {
    const found = byRun.get(runKey(mark)) ?? [];
    const defect = defects.get(mark.target);
    if (defect)
      outcomes.push(adjudicateRun(mark, found, [defect], manifest.input.tolerance, "defect"));
    else if (controls.has(mark.target)) {
      outcomes.push(adjudicateRun(mark, found, [], manifest.input.tolerance, "control"));
    } else unknownTargets.push(mark);
  }
  const order = (o: { config: string; run: string; target: string }): string => runKey(o);
  outcomes.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  unknownTargets.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  return { outcomes, unknownTargets };
}
