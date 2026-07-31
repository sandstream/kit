/**
 * Coverage / audit / analysis reporting leaves, extracted from cli.ts (5.0-alpha
 * god-module split): `kit self-audit` (kit's own source tree), `kit coverage`
 * (deterministic evidence map to ASVS / LLM-Top10 / SSDF), and `kit analyze`
 * (draft CLAUDE.md / RULES.md from a repo scan). `aggregateAdvisories` collapses
 * info-severity findings and is used only here, so it stays module-private.
 */
import { hasFlag } from "../utils/flags.js";
import { c } from "../utils/colors.js";
import { checkSecurity, type SecurityCheckResult } from "../check-security.js";
import { scanTranscripts } from "../scan-transcripts.js";
import { analyzeRepo, renderClaudeMd, renderRulesMd } from "../analyze.js";
import { resolveKitRoot, runSelfAudit, SELF_AUDIT_RULES } from "../self-audit.js";
import { buildCoverageReport, formatCoverageText, type Bucket } from "../coverage/coverage.js";
import { buildStandardReport, formatStandardText } from "../coverage/standard.js";
import {
  COVERAGE_STANDARDS,
  COVERAGE_STANDARD_KEYS,
  getCoverageStandard,
  enabledCoverageStandards,
  isCoverageStandardEnabled,
  type CoverageStandard,
} from "../coverage/registry.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import {
  type CiFormat,
  type JsonCheck,
  type JsonCheckOutput,
  detectCiFormat,
  emitGithubAnnotations,
  emitGitlabJunit,
} from "../cli-checks-shared.js";

export async function cmdSelfAudit(): Promise<boolean> {
  const args = process.argv.slice(2);

  // --list-rules: print the registry and exit (no audit run).
  if (hasFlag(args, "--list-rules")) {
    for (const r of SELF_AUDIT_RULES) {
      console.log(
        `${r.id}\t${r.name}\t${r.detectionClass}\t${r.severity}\t${r.enabled ? "enabled" : "disabled"}`,
      );
    }
    return true;
  }

  const formatArg = args.find((a) => a.startsWith("--format="))?.split("=")[1] as
    | CiFormat
    | undefined;
  const failOnWarning = hasFlag(args, "--fail-on-warning");
  const jsonMode = hasFlag(args, "--json");
  const format: CiFormat = formatArg ?? (jsonMode ? "json" : detectCiFormat());
  const onlyArg = args.find((a) => a.startsWith("--only="))?.split("=")[1];
  const only = onlyArg
    ? onlyArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  // self-audit targets kit's OWN source tree — not the user's project. Locate it
  // by walking up to the sandstream-kit package.json; if kit is installed in a way
  // that hides its sources, skip cleanly (not a failure).
  const root = resolveKitRoot();
  if (root === null) {
    console.log(
      `${c.yellow}kit source tree not found; self-audit targets kit itself and has nothing to scan here (skipped).${c.reset}`,
    );
    return true;
  }

  const results = runSelfAudit(root, only ? { only } : undefined);

  // Map SecurityCheckResult[] -> the CI JsonCheck shape, carrying file:line and
  // severity through. `info` (severity 'low') marks advisory findings: inventory,
  // not gating signal. Advisories are counted separately (NOT as warnings) so they
  // never trip --fail-on-warning, and annotation emitters exclude them.
  const checks: (JsonCheck & { info: boolean })[] = results.map((r) => ({
    name: r.name,
    status: r.status,
    detail: r.detail,
    category: r.category,
    files: r.files,
    severity: r.severity,
    info: r.severity === "low",
  }));

  const summary = checks.reduce(
    (acc, ch) => {
      if (ch.status === "pass") acc.passed++;
      else if (ch.status === "fail") acc.failed++;
      // Advisory (info) findings are tallied apart from real warnings.
      else if (ch.status === "warn") {
        if (ch.info) acc.advisories++;
        else acc.warnings++;
      } else acc.skipped++;
      return acc;
    },
    { passed: 0, failed: 0, warnings: 0, skipped: 0, advisories: 0 },
  );

  // Advisories never gate (not even under --fail-on-warning): only real warnings do.
  const allOk = summary.failed === 0 && (!failOnWarning || summary.warnings === 0);

  // One aggregated line per advisory class (e.g. "toolchain-pin: 72 ... (advisory)").
  const advisoryLines = aggregateAdvisories(checks.filter((ch) => ch.info));

  if (format === "github") {
    // Advisory (info-severity) findings are excluded from CI annotations — they are
    // inventory, not gating signal — but remain in text/json output.
    emitGithubAnnotations(checks.filter((ch) => !ch.info));
    console.log(
      `kit self-audit: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings, ${summary.advisories} advisories`,
    );
  } else if (format === "gitlab") {
    emitGitlabJunit(
      checks.filter((ch) => !ch.info),
      allOk,
    );
    console.log(
      `kit self-audit: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings, ${summary.advisories} advisories`,
    );
  } else if (format === "json") {
    const output: JsonCheckOutput = {
      ok: allOk,
      // Drop the internal `info` marker; keep advisories compact (one row per class).
      checks: [
        ...checks.filter((ch) => !ch.info).map(({ info: _info, ...ch }) => ch),
        ...advisoryLines.map((a) => ({
          name: a.cls,
          status: "warn" as const,
          detail: `${a.count} ${a.label} (advisory)`,
          category: a.cls,
          severity: "low" as const,
        })),
      ],
      summary,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    // text — grouped by detection class, PASS/WARN/FAIL per finding; advisories
    // collapsed to one line per class at the end.
    console.log(`${c.bold}${c.cyan}kit self-audit${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);
    const gating = checks.filter((ch) => !ch.info);
    const byClass = new Map<string, typeof checks>();
    for (const ch of gating) {
      const cls = ch.category;
      const bucket = byClass.get(cls);
      if (bucket) bucket.push(ch);
      else byClass.set(cls, [ch]);
    }
    for (const [cls, group] of byClass) {
      console.log(`\n${c.bold}${cls}${c.reset}`);
      for (const ch of group) {
        const tag =
          ch.status === "pass"
            ? `${c.green}PASS${c.reset}`
            : ch.status === "warn"
              ? `${c.yellow}WARN${c.reset}`
              : ch.status === "fail"
                ? `${c.red}FAIL${c.reset}`
                : `${c.dim}SKIP${c.reset}`;
        const where = ch.files && ch.files.length > 0 ? ` ${c.dim}(${ch.files[0]})${c.reset}` : "";
        console.log(`  ${tag} ${ch.name}: ${ch.detail}${where}`);
      }
    }
    if (advisoryLines.length > 0) {
      console.log(`\n${c.bold}advisories${c.reset}`);
      for (const a of advisoryLines) {
        console.log(`  ${c.dim}${a.cls}: ${a.count} ${a.label}${c.reset}`);
      }
    }
    console.log(
      `\n${SELF_AUDIT_RULES.length} rules, ${summary.failed} fail, ${summary.warnings} warn, ${summary.advisories} advisory`,
    );
  }

  return allOk;
}

/**
 * `kit coverage` — map kit's deterministic checks to the vendored OWASP ASVS L2
 * subset and report which controls kit auto-verifies vs gap / manual / n/a.
 *
 * This is an EVIDENCE map, not a compliance attestation: it never claims kit
 * makes a project "compliant" or "certified". It is the deterministic evidence
 * source a GRC tool (Vanta, Drata, ...) consumes — not a replacement for one.
 * Output is fully deterministic (the report is pure), so it is safe to diff in CI.
 */
export async function cmdCoverage(): Promise<boolean> {
  const args = process.argv.slice(2);
  const formatArg = args.find((a) => a.startsWith("--format="))?.split("=")[1];
  const jsonMode = hasFlag(args, "--json") || formatArg === "json";
  const verify = hasFlag(args, "--verify");

  // --verify binds AUTO controls to the ACTUAL latest backing-check results, so
  // "auto" reads as verified/failing/not-run instead of merely "a check is mapped".
  // Match is by concrete check/rule name; unmatched backing checks stay "not-run".
  let results: Awaited<ReturnType<typeof checkSecurity>> | undefined;
  if (verify) {
    const security = await checkSecurity();
    // self-audit only binds when kit's own source tree is reachable (it scans kit,
    // not the user's project); skip it cleanly otherwise — the security results
    // still bind. runSelfAudit is only meaningful on kit's own checkout.
    const root = resolveKitRoot();
    const selfAudit = root ? runSelfAudit(root) : [];
    // Command-backed evidence cheap enough to run inline (#206): CI hardening
    // lint + transcript credential scan. Synthesized under the exact ids the
    // coverage mapping cites, so those controls bind to a live run instead of
    // reading not-run. Heavier command evidence (kit secrets validate) stays
    // honestly unbound.
    const { runGhaAudit } = await import("../gha-audit.js");
    const { runCiAudit } = await import("../ci-audit.js");
    const ciResults = [...runGhaAudit(process.cwd()), ...runCiAudit(process.cwd())];
    const ciFails = ciResults.filter((r) => r.status === "fail").length;
    const transcriptHits = await scanTranscripts(process.cwd());
    const commandEvidence: SecurityCheckResult[] = [
      {
        category: "supply-chain",
        name: "gha-audit",
        status: ciResults.length === 0 ? "skip" : ciFails > 0 ? "fail" : "pass",
        detail:
          ciResults.length === 0
            ? "no CI workflows to lint"
            : `${ciResults.length} CI hardening check(s), ${ciFails} failing`,
      },
      {
        category: "secrets",
        name: "scan-transcripts",
        status: transcriptHits.length > 0 ? "warn" : "pass",
        detail:
          transcriptHits.length > 0
            ? `${transcriptHits.length} credential-shaped hit(s) in agent transcripts`
            : "no credentials found in agent transcripts",
      },
    ];
    results = [...security, ...selfAudit, ...commandEvidence];
  }

  const colorBucket = (bucket: Bucket, label: string): string => {
    const tint =
      bucket === "auto"
        ? c.green
        : bucket === "gap"
          ? c.yellow
          : bucket === "manual"
            ? c.cyan
            : c.dim;
    return `${tint}${label}${c.reset}`;
  };

  // Standards come from the registry (single source of truth). The optional
  // [coverage].standards allow-list in .kit.toml toggles which are enabled;
  // absent/empty ⇒ all on (backwards-compatible).
  const config = await loadConfig(resolveConfigPath()).catch(() => undefined);
  const configStandards = config?.coverage?.standards;

  // --list-standards: enumerate the registry (with on/off per the toggle) and exit.
  if (hasFlag(args, "--list-standards")) {
    for (const s of COVERAGE_STANDARDS) {
      const on = isCoverageStandardEnabled(s.key, configStandards);
      const tag = on ? `${c.green}on ${c.reset}` : `${c.dim}off${c.reset}`;
      console.log(`${tag} ${s.key.padEnd(14)} ${s.label} (${s.version})`);
    }
    return true;
  }

  // Render one standard: asvs uses the legacy report; descriptors use the engine.
  const renderOne = (std: CoverageStandard): { text: string; json: unknown } => {
    if (std.kind === "asvs") {
      const report = buildCoverageReport(results);
      return { text: formatCoverageText(report, colorBucket), json: report };
    }
    const report = buildStandardReport(std.descriptor!, results);
    return { text: formatStandardText(report, colorBucket), json: report };
  };

  // --standard selects the pinned standard (default asvs). "all" runs every
  // standard enabled by [coverage].standards.
  const standard = args.find((a) => a.startsWith("--standard="))?.split("=")[1] ?? "asvs";

  if (standard === "all") {
    const enabled = enabledCoverageStandards(configStandards);
    if (jsonMode) {
      const out: Record<string, unknown> = {};
      for (const s of enabled) out[s.key] = renderOne(s).json;
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(enabled.map((s) => renderOne(s).text).join("\n\n"));
    }
    return true;
  }

  const std = getCoverageStandard(standard);
  if (!std) {
    console.error(
      `${c.red}unknown --standard '${standard}' (use: ${COVERAGE_STANDARD_KEYS.join(" | ")} | all)${c.reset}`,
    );
    process.exitCode = 1;
    return false;
  }
  if (!isCoverageStandardEnabled(standard, configStandards)) {
    console.error(
      `${c.red}--standard '${standard}' is disabled in [coverage].standards (enable it there or drop the allow-list)${c.reset}`,
    );
    process.exitCode = 1;
    return false;
  }

  const one = renderOne(std);
  console.log(jsonMode ? JSON.stringify(one.json, null, 2) : one.text);
  return true;
}

/**
 * Collapse advisory (info) checks into one aggregated row per detection class.
 * Label is derived from the class slug so the line reads e.g.
 * "self-audit/toolchain-pin: 72 third-party CLI execs (advisory)".
 */
function aggregateAdvisories(
  advisories: { category: string }[],
): { cls: string; count: number; label: string }[] {
  const ADVISORY_LABELS: Record<string, string> = {
    "self-audit/toolchain-pin": "third-party CLI execs",
    "self-audit/env-trust": "env-gated check relaxations",
    "self-audit/flag-validation": "command modules that accept unknown flags",
  };
  const byClass = new Map<string, number>();
  for (const a of advisories) byClass.set(a.category, (byClass.get(a.category) ?? 0) + 1);
  return [...byClass.entries()].map(([cls, count]) => ({
    cls,
    count,
    label: ADVISORY_LABELS[cls] ?? "advisory findings",
  }));
}

export async function cmdAnalyze(): Promise<boolean> {
  // Flags: --claude, --rules to emit one or the other; default is both.
  // --write <dir> persists the drafts (suffix .draft.md so the user reviews
  // before committing).
  const args = process.argv.slice(3);
  const wantClaude =
    hasFlag(args, "--claude") || (!hasFlag(args, "--rules") && !hasFlag(args, "--claude"));
  const wantRules =
    hasFlag(args, "--rules") || (!hasFlag(args, "--rules") && !hasFlag(args, "--claude"));
  const writeFlagIdx = args.indexOf("--write");
  const writeDir = writeFlagIdx >= 0 ? (args[writeFlagIdx + 1] ?? process.cwd()) : null;

  console.log(`${c.bold}${c.cyan}kit analyze${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const report = await analyzeRepo(process.cwd());

  // Summary line — terse, machine-readable enough to grep
  const stack = report.stack;
  console.log(
    `${c.bold}Detected:${c.reset} ${stack.language}${stack.framework ? ` / ${stack.framework}` : ""}${
      stack.services.length ? ` + ${stack.services.join(", ")}` : ""
    }  ${c.dim}(confidence ${(stack.confidence * 100).toFixed(0)}%)${c.reset}`,
  );
  if (report.testRunners.length)
    console.log(`${c.dim}Tests:${c.reset} ${report.testRunners.join(", ")}`);
  if (report.deployTargets.length)
    console.log(`${c.dim}Deploy:${c.reset} ${report.deployTargets.join(", ")}`);
  if (report.databaseClients.length)
    console.log(`${c.dim}DB clients:${c.reset} ${report.databaseClients.join(", ")}`);
  if (report.ciFiles.length)
    console.log(`${c.dim}CI:${c.reset} ${report.ciFiles.length} workflow(s)`);
  if (report.commitPrefixes.length)
    console.log(
      `${c.dim}Commit prefixes:${c.reset} ${report.commitPrefixes
        .slice(0, 5)
        .map((p) => `${p.prefix}(${p.count})`)
        .join(", ")}`,
    );
  console.log();

  if (writeDir) {
    const { writeFile } = await import("node:fs/promises");
    if (wantClaude) {
      const path = `${writeDir}/CLAUDE.md.draft`;
      await writeFile(path, renderClaudeMd(report), "utf-8");
      console.log(`  ${c.green}✓${c.reset} wrote ${path}`);
      if (report.hasClaudeMd) {
        console.log(
          `    ${c.dim}(existing CLAUDE.md found — review draft before merging)${c.reset}`,
        );
      }
    }
    if (wantRules) {
      const path = `${writeDir}/RULES.md.draft`;
      await writeFile(path, renderRulesMd(report), "utf-8");
      console.log(`  ${c.green}✓${c.reset} wrote ${path}`);
      if (report.hasRulesMd) {
        console.log(
          `    ${c.dim}(existing RULES.md found — review draft before merging)${c.reset}`,
        );
      }
    }
    console.log();
    return true;
  }

  // No --write: print drafts to stdout for piping / inspection.
  if (wantClaude) {
    console.log(`${c.bold}── CLAUDE.md ${"─".repeat(40)}${c.reset}`);
    process.stdout.write(renderClaudeMd(report));
    console.log();
  }
  if (wantRules) {
    console.log(`${c.bold}── RULES.md ${"─".repeat(40)}${c.reset}`);
    process.stdout.write(renderRulesMd(report));
    console.log();
  }
  console.log(
    `${c.dim}Pipe to a file, or run with ${c.bold}--write .${c.reset}${c.dim} to materialize as CLAUDE.md.draft + RULES.md.draft${c.reset}`,
  );
  return true;
}
