/**
 * kit standards — the orchestrator shared by the CLI (`kit standards`) and the MCP
 * surface (kit_review's standards stage), so the two can never disagree on what the
 * gate does or what "green" means (the same CLI-vs-MCP parity discipline as `kit check`).
 *
 * Runs the requested dimensions — general (P1), specific/per-language (P2),
 * plugins (P3), platform (P4) — against the fail-closed baseline and config, and
 * returns a structured envelope { ok, checks, summary }. No printing here.
 */
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { KIT_FILE } from "./cli-shared.js";
import { loadBaselineForGate, baselineGet, type Baseline } from "./baseline.js";
import {
  checkStandards,
  type StandardsCheckResult,
  type StandardsThresholds,
} from "./check-standards.js";
import { checkStandardsSpecific, SPECIFIC_LANGUAGES } from "./check-standards-specific.js";
import { checkStandardsPlugins, DEFAULT_PLUGIN_DIR } from "./standards-plugins.js";
import { checkStandardsMjsPlugins } from "./standards-plugins-exec.js";
import { checkStandardsPlatform } from "./check-standards-platform.js";
import { detectStack } from "./stack-detector.js";

export interface StandardsSummary {
  score: string;
  passed: number;
  ran: number;
  findings: number;
  failed: number;
  setupGaps: number;
}

export interface StandardsRunResult {
  ok: boolean;
  checks: StandardsCheckResult[];
  summary: StandardsSummary;
  baselineIgnored: string | null;
}

export interface RunStandardsOptions {
  cwd?: string;
  enforce?: boolean;
  /** general | specific | plugins | platform | <language>; undefined ⇒ all. */
  category?: string;
}

type KitConfig = Awaited<ReturnType<typeof loadConfig>>;

/** What every dimension reads: the repo, the config, the baseline and the enforce flag. */
interface GateContext {
  cwd: string;
  config: KitConfig;
  baseline: Baseline;
  enforce: boolean;
}

/** Which dimensions the requested category selects. */
interface DimensionPlan {
  /** A per-language category such as "python"; it names the language to check. */
  langCategory: string | undefined;
  general: boolean;
  specific: boolean;
  plugins: boolean;
  platform: boolean;
}

function planDimensions(category: string | undefined): DimensionPlan {
  const langCategory = category && SPECIFIC_LANGUAGES.includes(category) ? category : undefined;
  return {
    langCategory,
    general: !category || category === "general",
    specific: !category || category === "specific" || !!langCategory,
    plugins: !category || category === "plugins",
    platform: !category || category === "platform",
  };
}

/** The language for the specific and plugin dimensions: the category, else the detected stack. */
async function resolveLanguage(cwd: string, plan: DimensionPlan): Promise<string | undefined> {
  if (plan.langCategory) return plan.langCategory;
  if (plan.specific || plan.plugins) return (await detectStack(cwd)).language;
  return undefined;
}

/** `[standards.general]` limits; a value that is not a number is ignored. */
function generalThresholds(config: KitConfig): Partial<StandardsThresholds> {
  const g = config.standards?.general;
  const thresholds: Partial<StandardsThresholds> = {};
  if (typeof g?.max_complexity === "number") thresholds.maxComplexity = g.max_complexity;
  if (typeof g?.max_function_lines === "number") thresholds.maxFunctionLines = g.max_function_lines;
  if (typeof g?.max_file_lines === "number") thresholds.maxFileLines = g.max_file_lines;
  if (typeof g?.max_duplication_pct === "number") {
    thresholds.maxDuplicationPct = g.max_duplication_pct;
  }
  return thresholds;
}

function runGeneral(ctx: GateContext): Promise<StandardsCheckResult[]> {
  const { baseline } = ctx;
  return checkStandards({
    cwd: ctx.cwd,
    enforce: ctx.enforce,
    thresholds: generalThresholds(ctx.config),
    baseline: {
      complexity: baselineGet(baseline, "standards", "complexity"),
      complexityMetrics: baselineGet(baseline, "standards", "complexity_metrics"),
      duplication: baselineGet(baseline, "standards", "duplication"),
      size: baselineGet(baseline, "standards", "size"),
      sizeMetrics: baselineGet(baseline, "standards", "size_metrics"),
    },
  });
}

async function runSpecific(
  ctx: GateContext,
  language: string,
  plan: DimensionPlan,
  category: string | undefined,
): Promise<StandardsCheckResult[]> {
  if (SPECIFIC_LANGUAGES.includes(language)) {
    const langCfg = (ctx.config.standards as Record<string, unknown> | undefined)?.[language] as
      Record<string, boolean> | undefined;
    return checkStandardsSpecific({
      cwd: ctx.cwd,
      language,
      enforce: ctx.enforce,
      enabled: langCfg,
      baseline: baselineGet(ctx.baseline, "standards", `specific/${language}`),
    });
  }
  if (category === "specific" || plan.langCategory) {
    return [
      {
        category: "standards",
        dimension: "specific",
        name: `specific (${language})`,
        status: "skip",
        detail: `no per-language standards gate for '${language}' yet (covers ${SPECIFIC_LANGUAGES.join(", ")})`,
      },
    ];
  }
  return [];
}

async function runPlugins(ctx: GateContext, language: string): Promise<StandardsCheckResult[]> {
  const configured = ctx.config.standards?.plugins?.dirs;
  const dirs = configured && configured.length > 0 ? configured : [DEFAULT_PLUGIN_DIR];
  const rest = {
    language,
    enforce: ctx.enforce,
    dirs,
    baseline: baselineGet(ctx.baseline, "standards", "plugins"),
  };
  return [
    ...checkStandardsPlugins({ cwd: ctx.cwd, ...rest }),
    ...(await checkStandardsMjsPlugins({ cwd: ctx.cwd, ...rest })),
  ];
}

function runPlatform(ctx: GateContext): Promise<StandardsCheckResult[]> {
  return checkStandardsPlatform({
    cwd: ctx.cwd,
    enforce: ctx.enforce,
    baseline: baselineGet(ctx.baseline, "standards", "platform"),
  });
}

/** The score counts gates that ran. Setup gaps are counted apart and are not findings. */
function summarize(checks: StandardsCheckResult[]): StandardsSummary {
  const gaps = checks.filter((r) => r.didNotRun);
  const ran = checks.filter((r) => !r.didNotRun && r.status !== "skip");
  const passed = ran.filter((r) => r.status === "pass").length;
  return {
    score: `${passed}/${ran.length}`,
    passed,
    ran: ran.length,
    findings: ran.filter((r) => r.status === "warn" || r.status === "fail").length,
    failed: checks.filter((r) => r.status === "fail").length,
    setupGaps: gaps.length,
  };
}

export async function runStandardsGate(
  opts: RunStandardsOptions = {},
): Promise<StandardsRunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const { baseline, ignored: baselineIgnored } = await loadBaselineForGate(cwd);
  const config = await loadConfig(resolve(cwd, KIT_FILE)).catch(() => ({}) as KitConfig);
  const enforce = (opts.enforce ?? false) || config.standards?.enforce === true;
  const ctx: GateContext = { cwd, config, baseline, enforce };

  const plan = planDimensions(opts.category);
  const language = await resolveLanguage(cwd, plan);

  const checks: StandardsCheckResult[] = [];
  if (plan.general) checks.push(...(await runGeneral(ctx)));
  if (plan.specific && language) {
    checks.push(...(await runSpecific(ctx, language, plan, opts.category)));
  }
  if (plan.plugins && language) checks.push(...(await runPlugins(ctx, language)));
  if (plan.platform) checks.push(...(await runPlatform(ctx)));

  const ok = checks.every((r) => r.status !== "fail");
  return { ok, checks, summary: summarize(checks), baselineIgnored };
}
