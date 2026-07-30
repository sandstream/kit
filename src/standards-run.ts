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
import { loadBaselineForGate, baselineGet } from "./baseline.js";
import { checkStandards, type StandardsCheckResult } from "./check-standards.js";
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

export async function runStandardsGate(
  opts: RunStandardsOptions = {},
): Promise<StandardsRunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const { baseline, ignored: baselineIgnored } = await loadBaselineForGate(cwd);
  const config = await loadConfig(resolve(cwd, KIT_FILE)).catch(
    () => ({}) as Awaited<ReturnType<typeof loadConfig>>,
  );
  const effectiveEnforce = (opts.enforce ?? false) || config.standards?.enforce === true;

  const category = opts.category;
  const langCategory = category && SPECIFIC_LANGUAGES.includes(category) ? category : undefined;
  const runGeneral = !category || category === "general";
  const runSpecific = !category || category === "specific" || !!langCategory;
  const runPlugins = !category || category === "plugins";
  const runPlatform = !category || category === "platform";

  let language = langCategory;
  if ((runSpecific || runPlugins) && !language) {
    language = (await detectStack(cwd)).language;
  }

  const checks: StandardsCheckResult[] = [];

  if (runGeneral) {
    const g = config.standards?.general;
    const thresholds = {
      ...(typeof g?.max_complexity === "number" ? { maxComplexity: g.max_complexity } : {}),
      ...(typeof g?.max_function_lines === "number"
        ? { maxFunctionLines: g.max_function_lines }
        : {}),
      ...(typeof g?.max_file_lines === "number" ? { maxFileLines: g.max_file_lines } : {}),
      ...(typeof g?.max_duplication_pct === "number"
        ? { maxDuplicationPct: g.max_duplication_pct }
        : {}),
    };
    checks.push(
      ...(await checkStandards({
        cwd,
        enforce: effectiveEnforce,
        thresholds,
        baseline: {
          complexity: baselineGet(baseline, "standards", "complexity"),
          duplication: baselineGet(baseline, "standards", "duplication"),
          size: baselineGet(baseline, "standards", "size"),
        },
      })),
    );
  }

  if (runSpecific && language) {
    if (SPECIFIC_LANGUAGES.includes(language)) {
      const langCfg = (config.standards as Record<string, unknown> | undefined)?.[language] as
        | Record<string, boolean>
        | undefined;
      checks.push(
        ...(await checkStandardsSpecific({
          cwd,
          language,
          enforce: effectiveEnforce,
          enabled: langCfg,
          baseline: baselineGet(baseline, "standards", `specific/${language}`),
        })),
      );
    } else if (category === "specific" || langCategory) {
      checks.push({
        category: "standards",
        dimension: "specific",
        name: `specific (${language})`,
        status: "skip",
        detail: `no per-language standards gate for '${language}' yet (covers ${SPECIFIC_LANGUAGES.join(", ")})`,
      });
    }
  }

  if (runPlugins && language) {
    const pluginCfg = config.standards?.plugins;
    const dirs =
      pluginCfg?.dirs && pluginCfg.dirs.length > 0 ? pluginCfg.dirs : [DEFAULT_PLUGIN_DIR];
    const pluginBaseline = baselineGet(baseline, "standards", "plugins");
    checks.push(
      ...checkStandardsPlugins({
        cwd,
        language,
        enforce: effectiveEnforce,
        dirs,
        baseline: pluginBaseline,
      }),
    );
    checks.push(
      ...(await checkStandardsMjsPlugins({
        cwd,
        language,
        enforce: effectiveEnforce,
        dirs,
        baseline: pluginBaseline,
      })),
    );
  }

  if (runPlatform) {
    checks.push(
      ...(await checkStandardsPlatform({
        cwd,
        enforce: effectiveEnforce,
        baseline: baselineGet(baseline, "standards", "platform"),
      })),
    );
  }

  const ok = checks.every((r) => r.status !== "fail");
  const gaps = checks.filter((r) => r.didNotRun);
  const ran = checks.filter((r) => !r.didNotRun && r.status !== "skip");
  const passed = ran.filter((r) => r.status === "pass").length;
  const failed = checks.filter((r) => r.status === "fail").length;
  const findings = ran.filter((r) => r.status === "warn" || r.status === "fail").length;
  const summary: StandardsSummary = {
    score: `${passed}/${ran.length}`,
    passed,
    ran: ran.length,
    findings,
    failed,
    setupGaps: gaps.length,
  };

  return { ok, checks, summary, baselineIgnored };
}
