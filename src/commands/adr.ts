/**
 * `kit adr` — ADR → gate. Enforce the machine-readable `kit-enforce` block of an
 * accepted Architecture Decision Record, cited back to the ADR. Design:
 * kit-research/docs/research/adr-as-enforced-rule-design.md.
 *
 *   kit adr list    every ADR + status + enforced / documented-only
 *   kit adr check   run accepted ADRs' rules over the repo (default): forbid_pattern,
 *                   require_pattern, and forbid_import (direct + transitive)
 *   kit adr freeze  snapshot current violations/gaps into .kit-baseline.json so only
 *                   NEW ones gate (mirrors `kit standards freeze`)
 *
 * kit never interprets ADR prose (off-charter); it enforces only the explicit
 * toml block. Only `accepted` ADRs gate; an accepted ADR with no rules is surfaced
 * as "documented, not enforced" — never silently green. A transitive forbid_import
 * that hits an unresolvable relative import is a `gap` (can't prove), not a pass.
 *
 * `adrCheck` is the embeddable gate reused by `kit review` and the pre-commit hook.
 */
import { readFileSync as read, existsSync as exists } from "node:fs";
import { relative as rel, join as pathJoin } from "node:path";
import { c } from "../utils/colors.js";
import { walkSourceFiles } from "../source-walk.js";
import { parseAdr, evaluateAdr, adrIsEnforced, type Adr, type AdrViolation } from "../adr.js";
import { baselineSet, type Baseline } from "../baseline.js";

const ADR_DIRS = ["docs/adr", "docs/decisions"];
const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php"];
const BASELINE_CATEGORY = "adr";

function loadAdrs(cwd: string): { adr: Adr; file: string }[] {
  const out: { adr: Adr; file: string }[] = [];
  for (const dir of ADR_DIRS) {
    const abs = pathJoin(cwd, dir);
    if (!exists(abs)) continue;
    for (const f of walkSourceFiles(abs, { exts: [".md"] })) {
      const adr = parseAdr(read(f, "utf-8"));
      if (adr) out.push({ adr, file: rel(cwd, f) });
    }
  }
  return out;
}

/**
 * Stable identity of a finding for baselining — deliberately EXCLUDES the line number so an
 * unrelated edit that shifts lines does not silently un-freeze (or re-raise) a known finding.
 */
export function adrFindingKey(v: AdrViolation): string {
  return `${v.adrId}|${v.rule}|${v.file}|${v.detail}`;
}

export interface AdrFindings {
  adrCount: number;
  enforcedCount: number;
  violations: AdrViolation[];
  gaps: AdrViolation[];
}

/** Gather every accepted ADR's findings over the repo. Pure-ish (reads the repo, no gating). */
export function collectAdrFindings(cwd: string): AdrFindings {
  const adrs = loadAdrs(cwd);
  const files = walkSourceFiles(cwd, { exts: CODE_EXTS, includeTests: true }).map((f) => ({
    path: rel(cwd, f),
    content: read(f, "utf-8"),
  }));
  const violations: AdrViolation[] = [];
  const gaps: AdrViolation[] = [];
  let enforcedCount = 0;
  for (const { adr } of adrs) {
    if (!adrIsEnforced(adr)) continue;
    enforcedCount++;
    for (const v of evaluateAdr(adr, files)) {
      (v.kind === "gap" ? gaps : violations).push(v);
    }
  }
  return { adrCount: adrs.length, enforcedCount, violations, gaps };
}

/** Snapshot current ADR violations + gaps into the baseline. Returns the number frozen. */
export function freezeAdrBaseline(baseline: Baseline, cwd: string): number {
  const { violations, gaps } = collectAdrFindings(cwd);
  const vKeys = violations.map(adrFindingKey);
  const gKeys = gaps.map(adrFindingKey);
  baselineSet(baseline, BASELINE_CATEGORY, "violations", vKeys);
  baselineSet(baseline, BASELINE_CATEGORY, "gaps", gKeys);
  return vKeys.length + gKeys.length;
}

/**
 * The embeddable ADR gate. Loads the baseline (fail-open on a corrupt file — a baseline only
 * ever SUPPRESSES, so an unreadable one gates on everything), suppresses frozen findings, prints,
 * and returns ok. Shared by `kit adr check`, `kit review`, and the pre-commit hook.
 */
export async function adrCheck(cwd = process.cwd()): Promise<boolean> {
  const adrs = loadAdrs(cwd);
  if (adrs.length === 0) {
    console.log(
      `${c.dim}No ADRs found in ${ADR_DIRS.join(" or ")}. Add one with a --- frontmatter (id/title/status) and a \`\`\`toml kit-enforce block.${c.reset}`,
    );
    return true;
  }

  const { loadBaselineForGate, baselineGet, BASELINE_FILE } = await import("../baseline.js");
  const { baseline, ignored } = await loadBaselineForGate(cwd);
  if (ignored) {
    console.log(
      `${c.yellow}!${c.reset} ${BASELINE_FILE} ignored (${ignored}) — gating on all findings`,
    );
  }
  const frozen = new Set([
    ...baselineGet(baseline, BASELINE_CATEGORY, "violations"),
    ...baselineGet(baseline, BASELINE_CATEGORY, "gaps"),
  ]);

  const { enforcedCount, violations, gaps } = collectAdrFindings(cwd);
  const liveViolations = violations.filter((v) => !frozen.has(adrFindingKey(v)));
  const liveGaps = gaps.filter((v) => !frozen.has(adrFindingKey(v)));

  for (const v of liveViolations) {
    console.log(
      `${c.red}✗${c.reset} ${v.file}:${v.line}  ${v.message}  ${c.dim}(${v.adrId})${c.reset}`,
    );
  }
  for (const v of liveGaps) {
    console.log(
      `${c.yellow}?${c.reset} ${v.file}:${v.line}  ${v.message}  ${c.dim}(${v.adrId})${c.reset}`,
    );
  }

  if (enforcedCount === 0) {
    console.log(
      `${c.yellow}No accepted ADR carries an enforce block — nothing to gate (documented, not enforced).${c.reset}`,
    );
    return true;
  }
  const suppressed = violations.length - liveViolations.length + (gaps.length - liveGaps.length);
  const suffix = suppressed ? ` ${c.dim}(${suppressed} baselined)${c.reset}` : "";
  if (liveViolations.length === 0 && liveGaps.length === 0) {
    console.log(
      `${c.green}✓ ${enforcedCount} enforced ADR(s) — no new violations${c.reset}${suffix}`,
    );
    return true;
  }
  const parts: string[] = [];
  if (liveViolations.length) parts.push(`${liveViolations.length} violation(s)`);
  if (liveGaps.length) parts.push(`${liveGaps.length} unprovable rule(s) (unresolved imports)`);
  console.log(
    `\n${c.red}${parts.join(" + ")} across ${enforcedCount} enforced ADR(s).${c.reset}${suffix}`,
  );
  return false;
}

export async function cmdAdr(): Promise<boolean> {
  const args = process.argv.slice(3);
  const sub =
    args[0] === "list" || args[0] === "check" || args[0] === "freeze"
      ? args[0]
      : args[0]
        ? "help"
        : "check";
  const cwd = process.cwd();

  if (sub === "help") {
    console.log(`${c.bold}kit adr${c.reset} — enforce architecture decisions (ADR → gate)\n`);
    console.log("  kit adr list     ADRs + status + enforced/documented");
    console.log("  kit adr check    gate the repo on accepted ADRs' rules (default)");
    console.log("  kit adr freeze   snapshot current findings into the baseline");
    return true;
  }

  if (sub === "list") {
    const adrs = loadAdrs(cwd);
    if (adrs.length === 0) {
      console.log(`${c.dim}No ADRs found in ${ADR_DIRS.join(" or ")}.${c.reset}`);
      return true;
    }
    console.log(`${c.bold}ADRs${c.reset}`);
    for (const { adr, file } of adrs) {
      const state = adrIsEnforced(adr)
        ? `${c.green}enforced (${adr.rules.length} rule${adr.rules.length === 1 ? "" : "s"})${c.reset}`
        : adr.status === "accepted"
          ? `${c.yellow}documented, not enforced${c.reset}`
          : `${c.dim}${adr.status}${c.reset}`;
      console.log(`  ${adr.id}  ${adr.title}  [${state}]  ${c.dim}${file}${c.reset}`);
    }
    return true;
  }

  if (sub === "freeze") {
    const { loadBaseline, saveBaseline, BASELINE_FILE } = await import("../baseline.js");
    const baseline = await loadBaseline(cwd);
    const total = freezeAdrBaseline(baseline, cwd);
    await saveBaseline(baseline, cwd);
    console.log(
      `${c.green}✓${c.reset} Wrote ${BASELINE_FILE} — ${total} ADR finding(s) frozen. Future runs gate only on NEW findings.`,
    );
    return true;
  }

  return adrCheck(cwd);
}
