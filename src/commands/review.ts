/**
 * `kit review` — meta-runner: check + design + standards + ADR + skill discipline in one shot.
 * Convenient single-command gate for AI agents and PR checks.
 *
 * collectReview is the structured core: it runs every stage's shared gate
 * (check-run, design, standards-run, adr, skill-run) and returns one ReviewReport.
 * cmdReview is a renderer on top; the MCP `kit_review` tool serializes the
 * same report — the computeCheckVerdict pattern, so the CLI and MCP surfaces
 * can never diverge on what a review runs or what "green" means.
 *
 * Pure read: no PAL sync, attestation, hints, or scanner self-heal — those are
 * `kit check`'s own CLI extras. `kit review` is the gate, not the fixer.
 */
import { c } from "../utils/colors.js";
import { hasFlag, flagValue, envTruthy } from "../utils/flags.js";
import { loadConfig, type kitConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { withGovernance } from "../governance-middleware.js";
import { runCheckGate, checkRunToJsonChecks } from "../check-run.js";
import { runStandardsGate } from "../standards-run.js";
import { runDesignGate } from "./design.js";
import { runAdrGate } from "./adr.js";
import { runSkillGate } from "../skill-run.js";
import type { JsonCheck } from "../cli-checks-shared.js";
import type { GateOpts } from "../check-security.js";

export type ReviewStageName = "check" | "design" | "standards" | "adr" | "skill";

export interface ReviewStageReport {
  stage: ReviewStageName;
  /** The stage gate's own verdict — authoritative. Findings are presentation:
   *  a stage can be red on a warn-level row (e.g. an outdated hook), so do not
   *  re-derive ok from finding statuses. */
  ok: boolean;
  summary: { pass: number; fail: number; warn: number; skip: number };
  findings: JsonCheck[];
}

export interface ReviewReport {
  ok: boolean;
  /** The stages that are NOT ok — for a precise "red because: …" message. */
  failed: ReviewStageName[];
  stages: ReviewStageReport[];
}

export const REVIEW_STAGES: readonly ReviewStageName[] = [
  "check",
  "design",
  "standards",
  "adr",
  "skill",
];

export interface CollectReviewOptions {
  cwd?: string;
  /** Preloaded config for the check stage (the CLI already has one for governance). */
  config?: kitConfig;
  /** Fail (not warn) on net-new design/standards findings and setup gaps (CI posture). */
  enforce?: boolean;
  /** Fail (not warn) on untested files — `--enforce-tests`. */
  enforceTests?: boolean;
  /** Security gate posture (lenient / fail-on-warning) for the check stage. */
  gate?: GateOpts;
  /** Run only these stages (canonical order is kept regardless of input order).
   *  THE scoped, read-only path: an agent iterating on standards findings runs
   *  `stages: ["standards"]` in seconds instead of paying the full audit's
   *  security scan per loop — and it survives kit_standards' 6.0 removal.
   *  Undefined ⇒ every stage. */
  stages?: ReviewStageName[];
  /** Standards-stage scope (general | specific | plugins | platform | <language>),
   *  passed through to the standards gate — parity with `kit standards --category`. */
  category?: string;
}

function summarize(findings: JsonCheck[]): ReviewStageReport["summary"] {
  const summary = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const f of findings) summary[f.status]++;
  return summary;
}

function stageReport(
  stage: ReviewStageName,
  ok: boolean,
  findings: JsonCheck[],
): ReviewStageReport {
  return { stage, ok, summary: summarize(findings), findings };
}

/** ADR gate result → review findings (one row per live violation/gap, or one summary row). */
function adrFindings(adr: Awaited<ReturnType<typeof runAdrGate>>): JsonCheck[] {
  if (adr.adrCount === 0) {
    return [
      {
        name: "adr",
        status: "skip",
        detail: "no ADRs found in docs/adr or docs/decisions",
        category: "adr",
      },
    ];
  }
  if (adr.enforcedCount === 0) {
    return [
      {
        name: "adr",
        status: "skip",
        detail: `${adr.adrCount} ADR(s), none carries an enforce block — documented, not enforced`,
        category: "adr",
      },
    ];
  }
  const rows: JsonCheck[] = [
    ...adr.violations.map((v) => ({
      name: v.adrId,
      status: "fail" as const,
      detail: `${v.file}:${v.line} ${v.message}`,
      category: "adr",
    })),
    ...adr.gaps.map((v) => ({
      name: v.adrId,
      status: "warn" as const,
      detail: `${v.file}:${v.line} ${v.message} (unprovable — unresolved import)`,
      category: "adr",
    })),
  ];
  if (rows.length === 0) {
    rows.push({
      name: "adr",
      status: "pass",
      detail:
        `${adr.enforcedCount} enforced ADR(s) — no new violations` +
        (adr.suppressed ? ` (${adr.suppressed} baselined)` : ""),
      category: "adr",
    });
  }
  return rows;
}

/**
 * Run the requested review stages (default: all four) and return the structured
 * report. Read-only; stages run in the order the CLI always ran them
 * (check → design → standards → adr → skill) regardless of the input order. The report
 * covers exactly the stages that ran — a scoped run's `ok` says nothing about
 * the stages it skipped, and the `stages` array shows the scope honestly.
 */
export async function collectReview(opts: CollectReviewOptions = {}): Promise<ReviewReport> {
  const wanted = new Set<ReviewStageName>(opts.stages ?? REVIEW_STAGES);
  const stages: ReviewStageReport[] = [];

  if (wanted.has("check")) {
    const check = await runCheckGate({
      cwd: opts.cwd,
      config: opts.config,
      enforceTests: opts.enforceTests,
      gate: opts.gate,
    });
    stages.push(stageReport("check", check.ok, checkRunToJsonChecks(check)));
  }
  if (wanted.has("design")) {
    const design = await runDesignGate({ cwd: opts.cwd, enforce: opts.enforce });
    stages.push(stageReport("design", design.ok, design.checks));
  }
  if (wanted.has("standards")) {
    const standards = await runStandardsGate({
      cwd: opts.cwd,
      enforce: opts.enforce,
      category: opts.category,
    });
    stages.push(stageReport("standards", standards.ok, standards.checks));
  }
  if (wanted.has("adr")) {
    const adr = await runAdrGate(opts.cwd ?? process.cwd());
    stages.push(stageReport("adr", adr.ok, adrFindings(adr)));
  }
  if (wanted.has("skill")) {
    // Module discipline over every SKILL.md the repo ships. A repo with no skills skips
    // honestly; a repo with one gets a verdict instead of the silence this stage replaces.
    const skill = runSkillGate(opts.cwd ?? process.cwd());
    stages.push(stageReport("skill", skill.ok, skill.checks));
  }

  const failed = stages.filter((s) => !s.ok).map((s) => s.stage);
  return { ok: failed.length === 0, failed, stages };
}

const ICON: Record<JsonCheck["status"], string> = {
  pass: `${c.green}✓${c.reset}`,
  fail: `${c.red}✗${c.reset}`,
  warn: `${c.yellow}!${c.reset}`,
  skip: `${c.dim}-${c.reset}`,
};

export async function cmdReview(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const enforce = hasFlag(process.argv, "--enforce");
  const enforceTests = hasFlag(process.argv, "--enforce-tests");
  const lenient = hasFlag(process.argv, "--lenient") || envTruthy(process.env.KIT_CI_LENIENT);
  const failOnWarning =
    hasFlag(process.argv, "--fail-on-warning") ||
    hasFlag(process.argv, "--strict") ||
    envTruthy(process.env.KIT_CI_STRICT);
  // --stages check,standards — scoped run (same semantics as the MCP tool's
  // `stages` param). An unknown name is a refusal, not a silent full run.
  const stagesFlag = flagValue(process.argv, "--stages");
  let stages: ReviewStageName[] | undefined;
  if (stagesFlag) {
    const parsed = stagesFlag
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = parsed.filter((s) => !REVIEW_STAGES.includes(s as ReviewStageName));
    if (bad.length > 0) {
      console.error(
        `${c.red}✗ unknown stage(s): ${bad.join(", ")}${c.reset}  ${c.dim}(valid: ${REVIEW_STAGES.join(", ")})${c.reset}`,
      );
      return false;
    }
    stages = parsed as ReviewStageName[];
  }
  const category = flagValue(process.argv, "--category");
  const config = await loadConfig(resolveConfigPath());

  return await withGovernance(
    config,
    { operation: "review", operationType: "read", metadata: {} },
    async () => {
      if (!jsonMode) console.log(`${c.bold}kit review${c.reset} — full repo audit\n`);
      const report = await collectReview({
        config,
        enforce,
        enforceTests,
        gate: { lenient, failOnWarning },
        stages,
        category,
      });

      if (jsonMode) {
        console.log(JSON.stringify(report, null, 2));
        return report.ok;
      }

      for (const stage of report.stages) {
        console.log(`${c.bold}=== ${stage.stage} ===${c.reset}`);
        for (const f of stage.findings) {
          console.log(`  ${ICON[f.status]} ${f.name}  ${c.dim}${f.detail}${c.reset}`);
          if (f.files) for (const file of f.files) console.log(`      ${c.dim}- ${file}${c.reset}`);
        }
        const s = stage.summary;
        const verdict = stage.ok ? `${c.green}✓ ok${c.reset}` : `${c.red}✗ failed${c.reset}`;
        console.log(
          `  ${verdict} ${c.dim}(${s.pass} pass · ${s.fail} fail · ${s.warn} warn · ${s.skip} skip)${c.reset}\n`,
        );
      }

      console.log(
        `${c.bold}${
          report.ok
            ? `${c.green}✓ review passed`
            : `${c.red}✗ review failed — ${report.failed.join(", ")}`
        }${c.reset}`,
      );
      return report.ok;
    },
  );
}
