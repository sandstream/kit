/**
 * Text output for `rig plan` and `rig report`. Pure: data in, lines out. Every report ends
 * with ADR-0007's three limits, verbatim, so the numbers never travel without them.
 */
import type { RigManifest } from "./manifest.js";
import { compare, LIMITS, type Spread } from "./report.js";
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
    `and append its findings as JSONL to ${findingsPath} (one "none": true row if it found nothing).`,
    "",
  ];
  for (const d of m.defects)
    lines.push(`  defect  ${d.id.padEnd(12)} ${d.split.padEnd(8)} ${d.patch}`);
  for (const c of m.controls) lines.push(`  control ${c.id.padEnd(12)} ${"".padEnd(8)} ${c.patch}`);
  lines.push(
    "",
    `Row: {"run","config","target","file","line","claim","severity","model","model_version","date"}`,
    `Then: kit rig ingest ${findingsPath}; kit rig adjudicate; kit rig report`,
  );
  return lines;
}

function renderComparisons(result: RigResult): string[] {
  const lines: string[] = [];
  const stats = result.stats;
  for (let i = 0; i < stats.length; i++) {
    for (let j = i + 1; j < stats.length; j++) {
      for (const split of ["tune", "holdout"] as const) {
        const c = compare(stats[i][split], stats[j][split]);
        const what = c.verdict === "refused" ? `refused: ${c.reason}` : c.verdict;
        lines.push(`  ${stats[i].config} vs ${stats[j].config} (${split}): ${what}`);
      }
    }
  }
  return lines.length > 0 ? ["Comparisons (recall, min/max overlap rule):", ...lines, ""] : [];
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
    for (const [id, f] of Object.entries({ ...s.tune.perDefect, ...s.holdout.perDefect })) {
      lines.push(`    ${id.padEnd(12)} caught ${f.caught}/${f.reviewed}`);
    }
    lines.push("");
  }
  lines.push(...renderComparisons(result));
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
