/**
 * Text output for `rig plan` and `rig report`. Pure: data in, lines out. Every report ends
 * with ADR-0007's three limits, verbatim, so the numbers never travel without them.
 */
import type { RigManifest } from "./manifest.js";
import { compareConfigs, LIMITS, type Comparison, type Shortfall, type Spread } from "./report.js";
import { DIGEST_LIMIT } from "./instruments.js";
import type { RigResult } from "./store.js";

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const range = (s: Spread | null): string =>
  s ? `${pct(s.mean)} (min ${pct(s.min)}, max ${pct(s.max)})` : "not measured";

/** What to run outside kit for one frozen input. */
export function renderPlan(m: RigManifest, inputId: string, findingsPath: string): string[] {
  const lines = [
    `input id  ${inputId}`,
    `repo      ${m.input.repo} @ ${m.input.commit}`,
    `prompt    ${m.input.prompt}`,
    `tolerance ${m.input.tolerance} line(s)`,
    "",
    "For each target: check out the commit, apply its patch, run the reviewer with the prompt,",
    `and append its findings as JSONL to ${findingsPath} (one "none": true row if it found nothing,`,
    `one "failed": "<why>" row if the reviewer crashed, timed out or refused; a target with no row`,
    "in a run counts as not caught).",
    "",
  ];
  for (const d of m.defects)
    lines.push(`  defect  ${d.id.padEnd(12)} ${d.split.padEnd(8)} ${d.patch}`);
  for (const c of m.controls) lines.push(`  control ${c.id.padEnd(12)} ${"".padEnd(8)} ${c.patch}`);
  lines.push(
    "",
    `Row: {"run","config","target","file","line","claim","severity","model","model_version","date"}`,
    `     optional "model_digest": "<scheme>:<value>" (sha256:<hex>, snapshot:<id>), recorded, never verified`,
    `Then: kit rig ingest ${findingsPath}; kit rig adjudicate; kit rig report`,
  );
  return lines;
}

/** A verdict line. Recall overlap is not called "within spread" when volume differs tenfold. */
function verdictText(c: Comparison): string {
  if (c.verdict === "refused") return `refused: ${c.reason}`;
  if (c.volumeRatio === undefined) return c.verdict;
  const times = `findings per run differ ${Math.round(c.volumeRatio)}x`;
  return c.verdict === "within spread"
    ? `recall overlaps, but ${times}; recall alone does not compare them (see volume and precision)`
    : `${c.verdict} (${times})`;
}

function renderComparisons(result: RigResult): string[] {
  const lines: string[] = [];
  const stats = result.stats;
  for (let i = 0; i < stats.length; i++) {
    for (let j = i + 1; j < stats.length; j++) {
      for (const split of ["tune", "holdout"] as const) {
        const what = verdictText(compareConfigs(stats[i], stats[j], split));
        lines.push(`  ${stats[i].config} vs ${stats[j].config} (${split}): ${what}`);
      }
    }
  }
  return lines.length > 0 ? ["Comparisons (recall, min/max overlap rule):", ...lines, ""] : [];
}

const perRunText = (s: Spread | null | undefined): string =>
  s ? `${s.mean.toFixed(1)} (${s.min}–${s.max})` : "n/a";

/** Findings and duplicates per run, and the unmatched count: volume buys recall that only controls price. */
function volumeLine(v: NonNullable<RigResult["stats"][number]["volume"]>): string {
  const duplicates =
    v.duplicatesPerRun === undefined
      ? ""
      : `  duplicates per run ${perRunText(v.duplicatesPerRun)}`;
  return `findings per run ${perRunText(v.findingsPerRun)}${duplicates}  unmatched ${v.unmatched}`;
}

/** One line per run that did not review every target of a half: the shortfall the numbers include. */
function shortfallLines(what: string, shortfall: Shortfall[] | undefined): string[] {
  return (shortfall ?? []).map((s) => {
    const parts = [`  ${what} run ${s.run}: reviewed ${s.reviewed} of ${s.of}`];
    if (s.failed.length > 0)
      parts.push(`failed ${s.failed.map((f) => `${f.target} (${f.reason})`).join(", ")}`);
    if (s.missing.length > 0) parts.push(`no row ${s.missing.join(", ")}`);
    const counted = what === "controls" ? "counted as flagged" : "counted as not caught";
    return `${parts.join("; ")}; ${counted}`;
  });
}

/** The declared instruments, and the self-declared limit whenever a digest is shown. */
function instrumentLines(result: RigResult): string[] {
  const list = result.instruments ?? [];
  if (!list.some((i) => i.model_digest !== undefined)) return [];
  return [
    "Instruments (declared by the caller):",
    ...list.map(
      (i) =>
        `  ${i.config.padEnd(6)} ${i.model} ${i.model_version}  ${i.model_digest ?? "(no digest)"}  ${i.runs} run(s)`,
    ),
    `  ${DIGEST_LIMIT}`,
    "",
  ];
}

/** The full report for one adjudicated input. */
export function renderReport(result: RigResult, otherInputs: string[]): string[] {
  const lines = [
    `input id  ${result.inputId}`,
    `findings  ${result.receipt.findings.length} file(s)`,
    "",
  ];
  for (const s of result.stats) {
    lines.push(
      `config ${s.config}`,
      `  tune     ${s.tune.runs} run(s)  recall ${range(s.tune.recall)}`,
      `  holdout  ${s.holdout.runs} run(s)  recall ${range(s.holdout.recall)}`,
      `  controls ${s.controls.runs} run(s)  flagged ${range(s.controls.falsePositiveRate)}`,
    );
    if (s.volume) lines.push(`  volume   ${volumeLine(s.volume)}`);
    if (s.volume?.precision !== undefined) {
      lines.push(`  precision ${range(s.volume.precision)}  defects caught per finding`);
    }
    lines.push(
      ...shortfallLines("tune", s.tune.shortfall),
      ...shortfallLines("holdout", s.holdout.shortfall),
      ...shortfallLines("controls", s.controls.shortfall),
    );
    for (const [id, f] of Object.entries({ ...s.tune.perDefect, ...s.holdout.perDefect })) {
      lines.push(`    ${id.padEnd(12)} caught ${f.caught}/${f.reviewed}`);
    }
    lines.push("");
  }
  lines.push(...renderComparisons(result), ...instrumentLines(result));
  for (const w of result.warnings) lines.push(`warning: ${w}`);
  for (const u of result.unknownTargets) {
    lines.push(
      `warning: run ${u.run} of config ${u.config} reviewed unknown target "${u.target}"; not counted`,
    );
  }
  if (otherInputs.length > 0) {
    lines.push(`note: ${otherInputs.length} other input id(s) on record were not mixed in`);
  }
  lines.push(
    result.receipt.signature
      ? "receipt: signed"
      : `receipt: unsigned (${result.receipt.unsignedReason ?? "no identity"})`,
    "",
    "Limits (ADR-0007):",
    ...LIMITS.map((l, i) => `  ${i + 1}. ${l}`),
  );
  return lines;
}
