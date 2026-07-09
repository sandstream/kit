#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { writeFile, access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { loadConfig, type kitConfig } from "./config.js";
import type { Baseline } from "./baseline.js";
import { createInterface } from "node:readline/promises";
import { checkTools } from "./check-tools.js";
import { checkServices } from "./check-services.js";
import { checkSecrets } from "./check-secrets.js";
import { checkSecurity, gateStatus, type SecurityCheckResult } from "./check-security.js";
import type { HealthCtx } from "./health.js";
import type { SentinelSummary } from "./sentinel.js";
import { syncSecurityFindings } from "./findings-track.js";
import { checkWebSearch } from "./check-web-search.js";
import { installTools } from "./install.js";
import { loginServices } from "./login.js";
import { check1PasswordStatus, detect1PasswordMode } from "./onepassword.js";
import { isNonInteractive } from "./environment.js";
import { spawn as spawnChild } from "node:child_process";
import { promptSelect } from "./utils/promptSelect.js";
import { hasFlag, flagValue, envTruthy } from "./utils/flags.js";
import { scanPlaintextSecrets } from "./scan-plaintext.js";
import { analyzeRepo, renderClaudeMd, renderRulesMd } from "./analyze.js";
import { scanTranscripts } from "./scan-transcripts.js";
import { consumeElevation } from "./elevation.js";
import { checkGitignore, patchGitignore } from "./check-gitignore.js";
import type { SecretsStore } from "./toml-generator.js";
import { generateCompletions } from "./completions.js";
import { checkForUpdate, printUpdateNotice } from "./update-check.js";
import { resolveMode, MODE_NAMES, modeScore } from "./setup-modes.js";
import { quickSubsystems } from "./statusline.js";
import { checkSkills } from "./check-skills.js";
import { checkLockFiles } from "./check-lock.js";
import { collectEscalations, formatEscalationMessage } from "./escalate.js";
import {
  printToolsTable,
  printServicesTable,
  printSecretsTable,
  printSkillsTable,
  printWebSearchStatus,
  printSecurityTable,
  printLockTable,
  printSummary,
  runStep,
  stepHeader,
} from "./output.js";
import { checkRevocationStatus } from "./revocation.js";
import { getBudgetStatus, formatBudgetStatus } from "./budget.js";
import { formatGovernanceStatus, mergeGovernanceConfigAsync } from "./governance.js";
import { withGovernance } from "./governance-middleware.js";
import { SKIPPED_COMMITS_LOG } from "./hooks.js";
import {
  writeAgentConfig,
  detectAgentTargets,
  installKitPermissions,
  installAllInstallGates,
  installAiderRules,
} from "./agent-config.js";
import { applyRecommendedHardening } from "./recommended.js";
import { checkHooks, isGitRepository } from "./check-hooks.js";
import {
  readkitMeta,
  readSkillsLock,
  readCliLock,
  updateSkillsLock,
  updateCliLock,
} from "./lock.js";
import { provisionService, listAvailableServices, getServiceInfo } from "./provision.js";
import { cmdFix } from "./fix.js";
import { promptConfirm } from "./utils/prompt.js";
import { c } from "./utils/colors.js";
import { gatherStatus } from "./status.js";
import { KIT_FILE, resolveConfigPath } from "./cli-shared.js";
import { collectHints } from "./hints.js";
import {
  gatherLive,
  suggestContextToml,
  hasLockableContext,
  gcpProjectMismatch,
} from "./context-lock.js";
import { cmdEnv } from "./commands/env.js";
import { cmdContext } from "./commands/context.js";
import { cmdConfig } from "./commands/config.js";
import { cmdAirgap } from "./commands/airgap.js";
import { cmdScan } from "./commands/scan.js";
import { cmdVerifyProvenance } from "./commands/verify-provenance.js";
import { cmdGhaAudit } from "./commands/gha-audit.js";
import { cmdIdentity } from "./commands/identity.js";
import { cmdPanic } from "./commands/panic.js";
import { cmdPolicy } from "./commands/policy.js";
import { evaluatePolicy } from "./policy-check.js";
import { cmdSbom } from "./commands/sbom.js";
import { cmdSecurity } from "./commands/security.js";
import { cmdSecrets } from "./commands/secrets.js";
import { cmdAuth } from "./commands/auth.js";
import { cmdAudit } from "./commands/audit.js";
import { cmdMcp } from "./commands/mcp.js";
import { cmdHooks } from "./commands/hooks.js";
import { resolveAllAuth } from "./service-auth.js";
import { runDoctor } from "./doctor.js";
import { detectStack } from "./stack-detector.js";
import { generateToml, parseEnvTemplateKeys } from "./toml-generator.js";
import { vaultMeta, detectSecretStore } from "./vault-meta.js";
import { createPlugin } from "./create-plugin.js";
import { cmdPlugin } from "./plugins-cli.js";
import { cloneRepository } from "./clone.js";
import { executeCommand } from "./run.js";
import { listServices, openService } from "./open.js";
import { cmdTriage } from "./commands/triage.js";
import { cmdSlopsquat } from "./commands/slopsquat.js";
import { parsePkgSpec, installPkg } from "./pkg.js";
import { cmdMemory } from "./commands/memory.js";
import { resolveKitRoot, runSelfAudit, SELF_AUDIT_RULES } from "./self-audit.js";
import { buildCoverageReport, formatCoverageText, type Bucket } from "./coverage/coverage.js";
import { buildStandardReport, formatStandardText } from "./coverage/standard.js";
import { OWASP_LLM_TOP10 } from "./coverage/owasp-llm-top10.js";
import { SSDF_218A } from "./coverage/ssdf-218a.js";
import { escapeWorkflowCmd, xmlEscape } from "./utils/ci-escape.js";

// Re-exported for tests + downstream emitters (ci-escaping.test.ts imports these
// from "./cli.js"). The implementations live in utils/ci-escape.ts so the MCP
// server can reuse them without importing the whole CLI module.
export { escapeWorkflowCmd, xmlEscape };

const __dirname = dirname(fileURLToPath(import.meta.url));
const KIT_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string }
).version;

interface JsonCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  category: string;
  files?: string[];
  severity?: "critical" | "high" | "medium" | "low";
}

interface JsonCheckOutput {
  ok: boolean;
  checks: JsonCheck[];
  summary: {
    passed: number;
    failed: number;
    warnings: number;
    skipped: number;
    advisories?: number;
  };
}

/** Map a security finding to a short, actionable PAL title/detail. */
async function cmdHeal(): Promise<boolean> {
  const dryRun = hasFlag(process.argv, "--dry-run");
  const agent = hasFlag(process.argv, "--agent");
  console.log(
    `${c.bold}${c.cyan}kit heal${c.reset}${dryRun ? `${c.dim} (dry-run)${c.reset}` : ""}`,
  );
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const { runHeal } = await import("./heal.js");
  // Progress goes to stderr: live feedback for a human watching, without
  // polluting the machine-readable proposals on stdout (--agent).
  const res = await runHeal({ dryRun, onProgress: (m) => console.error(`${c.dim}${m}${c.reset}`) });
  console.log();

  if (dryRun) {
    if (res.plannedSafe.length > 0) {
      console.log(`${c.bold}Would auto-fix (safe):${c.reset}`);
      for (const k of res.plannedSafe) console.log(`  ${c.green}✓${c.reset} ${k}`);
    } else {
      console.log(`${c.dim}Nothing to auto-fix.${c.reset}`);
    }
  } else if (res.healed.length > 0) {
    console.log(`${c.green}${c.bold}Healed ${res.healed.length}:${c.reset}`);
    for (const k of res.healed) console.log(`  ${c.green}✓${c.reset} ${k}`);
  }

  // FAIL-CLOSED — loud, never auto-healed.
  if (res.failClosed.length > 0) {
    console.log(
      `\n${c.red}${c.bold}⚠ FAIL-CLOSED — not auto-healed (possible tampering):${c.reset}`,
    );
    for (const r of res.failClosed) {
      console.log(`  ${c.red}✗${c.reset} ${r.name}: ${r.detail}`);
      if (r.suggestion) console.log(`    ${c.dim}${r.suggestion}${c.reset}`);
    }
  }

  // GATED — proposed, never auto-run by kit.
  if (res.gated.length > 0) {
    console.log(`\n${c.yellow}${c.bold}Gated — needs you (kit won't auto-run these):${c.reset}`);
    for (const g of res.gated) {
      console.log(`  ${c.yellow}!${c.reset} ${g.name}: ${g.issue}`);
      console.log(`    ${c.dim}→ ${g.action}${c.reset}`);
    }
    if (agent) {
      console.log(
        `\n${c.dim}# agent: each command below still hits the elevation gate + audit log${c.reset}`,
      );
      for (const g of res.gated) console.log(g.action);
    }
  }

  const green = res.failClosed.length === 0 && res.gated.length === 0;
  console.log();
  if (!dryRun) {
    console.log(
      green
        ? `${c.green}${c.bold}All findings healed or clean ✓${c.reset}`
        : `${c.yellow}Auto-heal done; items above need you.${c.reset}`,
    );
  }
  return green;
}

/**
 * Emit a signed `.kit-check-attestation.json` receipt after a check/ci run, but
 * only when the operator opts in (`--attest` flag or `KIT_ATTEST=1`). Writing a
 * new file into the repo on every run would surprise scripted users, so it is
 * gated. The signing step is fail-soft inside emitAttestation: a signing failure
 * never alters the check verdict; at worst the receipt is unsigned.
 */
async function maybeEmitCheckAttestation(
  command: "check" | "ci",
  overallOk: boolean,
  summary: { passed: number; failed: number; warnings: number; skipped: number },
  scannersRan: { id: string; status: string }[],
  quiet: boolean,
): Promise<void> {
  if (!hasFlag(process.argv, "--attest") && !envTruthy(process.env.KIT_ATTEST)) return;
  const { emitAttestation } = await import("./check-attestation.js");
  const res = await emitAttestation(
    { command, kitVersion: KIT_VERSION, overallOk, results: summary, scannersRan },
    process.cwd(),
  );
  if (res && !quiet) {
    const signedNote =
      res.att.sig_alg === "none"
        ? `${c.yellow}unsigned (${res.att.unsigned_reason})${c.reset}`
        : `${c.dim}signed ${res.att.sig_alg}${c.reset}`;
    console.log(`${c.dim}attestation: ${res.path}${c.reset} ${signedNote}`);
  }
}

async function cmdCheck(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  // kit check verify-attestation <file> verifies a signed check receipt.
  if (process.argv[3] === "verify-attestation") {
    return cmdVerifyAttestation();
  }
  const enforceTests = hasFlag(process.argv, "--enforce-tests");
  // Scanner-health strict by default (see cmdCi): a check that could not RUN fails;
  // --lenient / KIT_CI_LENIENT downgrades those to warnings. Finding-warns stay
  // warnings unless --fail-on-warning / --strict / KIT_CI_STRICT.
  const lenient = hasFlag(process.argv, "--lenient") || envTruthy(process.env.KIT_CI_LENIENT);
  const failOnWarning =
    hasFlag(process.argv, "--fail-on-warning") ||
    hasFlag(process.argv, "--strict") ||
    envTruthy(process.env.KIT_CI_STRICT);
  const config = await loadConfig(resolveConfigPath());

  return await withGovernance(
    config,
    {
      operation: "check",
      operationType: "read",
      metadata: {},
    },
    async () => {
      const live = !jsonMode;
      if (live) stepHeader("Checks");
      const step = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
        live ? runStep(label, fn) : fn();

      const toolResults = config.tools ? await step("tools", () => checkTools(config.tools!)) : [];
      const serviceResults = config.services
        ? await step("services", () => checkServices(config.services!))
        : [];
      const secretResults = config.secrets
        ? await step("secrets", () => checkSecrets(config.secrets!))
        : { templateExists: null, keys: [] };
      const skillResults = config.skills
        ? await step("skills", () => checkSkills(config.skills!))
        : [];
      const hookResults =
        config.hooks && isGitRepository()
          ? await step("git hooks", () => checkHooks(config.hooks!))
          : [];
      const webSearchResult = config.web?.search
        ? await step("web search", () => checkWebSearch(config.web!.search!))
        : null;
      await autoInstallScanners(config, live); // self-heal missing scanners before scanning
      const securityResults = await step("security scan", () => checkSecurity());
      const lockResults = await step("lock files", () => checkLockFiles(config));

      // Test-coverage enforcement (--enforce-tests CLI flag overrides config).
      // Baseline-aware: pre-existing untested files only warn; net-new fail.
      const { checkTests } = await import("./check-tests.js");
      const { loadBaselineForGate, baselineGet, BASELINE_FILE } = await import("./baseline.js");
      const { baseline, ignored: baselineIgnored } = await loadBaselineForGate();
      if (baselineIgnored) {
        // Fail-closed + visible: a corrupt/tampered baseline is ignored (nothing
        // suppressed) and surfaced as a finding, never a crash of the gate.
        securityResults.push({
          category: "secrets",
          name: "baseline integrity",
          status: "warn",
          severity: "low",
          detail: `${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings; re-freeze with 'kit baseline freeze'`,
        });
      }
      const testResults = await step("test coverage", () =>
        checkTests({
          enforce: enforceTests,
          baseline: baselineGet(baseline, "tests", "untested_files"),
        }),
      );

      // Single source of truth for the green/ok verdict — the SAME function the
      // MCP `kit_check` tool uses, so the two surfaces can never disagree. Applies
      // scanner-health-strict security gating, the informational-service exemption,
      // and test-coverage in one place.
      const { computeCheckVerdict } = await import("./check-verdict.js");
      const verdict = computeCheckVerdict(
        {
          tools: toolResults,
          services: serviceResults,
          secrets: secretResults.keys,
          skills: skillResults,
          hooks: hookResults,
          security: securityResults,
          tests: testResults,
          locks: lockResults,
        },
        { lenient, failOnWarning },
      );
      const allOk = verdict.ok;

      // Track security findings in the PAL ledger (cross-session reminders +
      // auto-close on a clean re-scan). Opt out with [memory] track_findings = false.
      if (config.memory?.track_findings !== false) {
        const r = await syncSecurityFindings(securityResults);
        if (!jsonMode && r && (r.added || r.closed.length || r.reopened)) {
          const parts = [`+${r.added} tracked`];
          if (r.reopened) parts.push(`${r.reopened} reopened`);
          if (r.closed.length) parts.push(`−${r.closed.length} auto-closed`);
          console.log(`${c.dim}PAL: ${parts.join(" · ")}${c.reset}`);
        }
      }

      if (jsonMode) {
        const checks: JsonCheck[] = [
          ...toolResults.map((t) => ({
            name: t.name,
            status: (t.ok ? "pass" : "fail") as JsonCheck["status"],
            detail: t.installed ? `installed ${t.installed}` : "not installed",
            category: "tools",
          })),
          ...serviceResults.map((s) => ({
            name: s.name,
            status: (s.authenticated
              ? "pass"
              : s.informational
                ? "warn"
                : "fail") as JsonCheck["status"],
            detail: s.informational
              ? s.output || "manual setup (no CLI login)"
              : (s.output ?? (s.authenticated ? "authenticated" : "not authenticated")),
            category: "services",
          })),
          ...secretResults.keys.map((s) => ({
            name: s.name,
            status: (s.unverified ? "warn" : s.available ? "pass" : "fail") as JsonCheck["status"],
            detail: s.detail ?? (s.available ? "available" : "missing"),
            category: "secrets",
          })),
          ...skillResults.map((s) => ({
            name: s.name,
            status: (s.installed ? "pass" : s.required ? "fail" : "warn") as JsonCheck["status"],
            detail: s.installed ? "installed" : "not installed",
            category: "skills",
          })),
          ...hookResults.map((h) => ({
            name: h.hookName,
            status: (!h.installed ? "fail" : !h.upToDate ? "warn" : "pass") as JsonCheck["status"],
            detail: h.detail,
            category: "hooks",
          })),
          ...(webSearchResult
            ? [
                {
                  name: webSearchResult.provider,
                  status: (webSearchResult.healthy ? "pass" : "fail") as JsonCheck["status"],
                  detail:
                    webSearchResult.error ?? (webSearchResult.healthy ? "healthy" : "unhealthy"),
                  category: "web-search",
                },
              ]
            : []),
          ...lockResults.map((l) => ({
            name: l.category === "skills-lock" ? "skills-lock.json" : "cli-lock.json",
            status: (l.inSync ? "pass" : l.exists ? "warn" : "fail") as JsonCheck["status"],
            detail: l.detail,
            category: "lock",
          })),
          ...securityResults.map((s) => ({
            name: s.name,
            status: s.status,
            detail: s.detail,
            category: `security/${s.category}`,
          })),
          ...testResults.map((t) => ({
            name: t.name,
            status: t.status,
            detail: t.detail,
            category: "tests",
          })),
        ];

        const summary = checks.reduce(
          (acc, c) => {
            if (c.status === "pass") acc.passed++;
            else if (c.status === "fail") acc.failed++;
            else if (c.status === "warn") acc.warnings++;
            else acc.skipped++;
            return acc;
          },
          { passed: 0, failed: 0, warnings: 0, skipped: 0 },
        );

        const output: JsonCheckOutput = { ok: allOk, checks, summary };
        await maybeEmitCheckAttestation(
          "check",
          allOk,
          summary,
          securityResults.map((s) => ({ id: s.name, status: s.status })),
          true, // quiet: never print to stdout in --json mode
        );
        console.log(JSON.stringify(output, null, 2));
        return allOk;
      }

      printToolsTable(toolResults);
      printServicesTable(serviceResults);
      printSecretsTable(secretResults.templateExists, secretResults.keys);
      printSkillsTable(skillResults);
      printWebSearchStatus(webSearchResult);
      printLockTable(lockResults);

      // Print hooks status if configured
      if (hookResults.length > 0) {
        console.log(`${c.cyan}Git Hooks${c.reset}`);
        for (const r of hookResults) {
          const icon = !r.installed
            ? `${c.red}✗${c.reset}`
            : !r.upToDate
              ? `${c.yellow}!${c.reset}`
              : `${c.green}✓${c.reset}`;
          const status = !r.installed
            ? `${c.red}not installed${c.reset}`
            : !r.upToDate
              ? `${c.yellow}outdated${c.reset}`
              : `${c.green}up-to-date${c.reset}`;
          console.log(`  ${icon} ${r.hookName}  ${status}  ${c.dim}${r.detail}${c.reset}`);
        }
        console.log();
      }

      printSecurityTable(securityResults);

      // Render test-coverage results in the same compact style.
      if (testResults.length > 0) {
        console.log(`\n${c.bold}Tests${c.reset}`);
        for (const r of testResults) {
          const icon =
            r.status === "pass"
              ? `${c.green}✓${c.reset}`
              : r.status === "fail"
                ? `${c.red}✗${c.reset}`
                : r.status === "warn"
                  ? `${c.yellow}!${c.reset}`
                  : `${c.dim}-${c.reset}`;
          console.log(`  ${icon} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
          if (r.files && r.files.length > 0) {
            for (const f of r.files) console.log(`      ${c.dim}- ${f}${c.reset}`);
          }
        }
        console.log();
      }

      printSummary(toolResults, serviceResults, secretResults.keys, securityResults);

      // Deterministic, marker-gated "smart" tip — surfaces a relevant opt-in
      // capability (unsigned policy, unanchored audit log, missing trivy, …) at
      // most once. Fail-soft; never affects the verdict. Silence with KIT_NO_HINTS.
      for (const h of await collectHints(process.cwd())) {
        console.log(`${c.dim}💡 tip: ${h.tip}${c.reset}`);
      }

      // Opt-in signed attestation receipt (text mode). Summary is over the
      // security gates, consistent with scanners_ran; overall_ok is the whole
      // check verdict. Emission is fail-soft and never changes the verdict.
      {
        const attSummary = securityResults.reduce(
          (acc, s) => {
            if (s.status === "pass") acc.passed++;
            else if (s.status === "fail") acc.failed++;
            else if (s.status === "warn") acc.warnings++;
            else acc.skipped++;
            return acc;
          },
          { passed: 0, failed: 0, warnings: 0, skipped: 0 },
        );
        await maybeEmitCheckAttestation(
          "check",
          allOk,
          attSummary,
          securityResults.map((s) => ({ id: s.name, status: s.status })),
          false,
        );
      }

      // Surface a stale kit (a newer published version) as a warn — a stale CLI
      // can carry already-fixed bugs. Gated by [update].check; checkForUpdate
      // also self-skips in CI and with KIT_NO_UPDATE_CHECK=1, and returns null
      // when already on latest or the check fails.
      if (config.update?.check !== false) {
        const { checkForUpdate } = await import("./update-check.js");
        const u = await checkForUpdate(KIT_VERSION);
        if (u) {
          if (config.update?.auto === true) {
            // Opt-in auto-update — still WATERTIGHT: selfUpgrade triages kit's own
            // package and installs ONLY on a triage PASS. Never installs on fail.
            console.log(
              `${c.yellow}! kit ${u.current} → ${u.latest} — auto-update on, triaging before install…${c.reset}`,
            );
            await selfUpgrade();
          } else {
            console.log(
              `${c.yellow}! kit ${u.current} → ${u.latest} available${c.reset} ${c.dim}— run ${c.reset}${c.bold}kit upgrade --self${c.reset}${c.dim} (triages before installing)${c.reset}\n`,
            );
          }
        }
      }

      return allOk;
    },
  );
}

/**
 * `kit design` — a11y + design-token consistency, baseline-aware.
 */
async function cmdDesign(): Promise<boolean> {
  const enforce = hasFlag(process.argv, "--enforce");
  const jsonMode = hasFlag(process.argv, "--json");
  const { checkDesign } = await import("./check-design.js");
  const { loadBaselineForGate, baselineGet, BASELINE_FILE } = await import("./baseline.js");
  const { baseline, ignored: baselineIgnored } = await loadBaselineForGate();
  if (baselineIgnored) {
    console.error(
      `${c.yellow}!${c.reset} ${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings`,
    );
  }
  const results = await checkDesign({
    enforce,
    baseline: {
      a11y: baselineGet(baseline, "design", "a11y"),
      tokens: baselineGet(baseline, "design", "tokens"),
    },
  });
  if (jsonMode) {
    console.log(
      JSON.stringify({ ok: results.every((r) => r.status !== "fail"), checks: results }, null, 2),
    );
    return results.every((r) => r.status !== "fail");
  }
  console.log(`${c.bold}Design${c.reset}`);
  for (const r of results) {
    const icon =
      r.status === "pass"
        ? `${c.green}✓${c.reset}`
        : r.status === "fail"
          ? `${c.red}✗${c.reset}`
          : r.status === "warn"
            ? `${c.yellow}!${c.reset}`
            : `${c.dim}-${c.reset}`;
    console.log(`  ${icon} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
    if (r.files) for (const f of r.files) console.log(`      ${c.dim}- ${f}${c.reset}`);
  }
  return results.every((r) => r.status !== "fail");
}

/**
 * `kit standards` — the deterministic dev-standards gate (P1: the general,
 * language-agnostic code-quality metrics via lizard/jscpd/scc). Mirrors `kit design`:
 * warn by default, `--enforce` fails on net-new findings AND on setup gaps (a tool
 * that could not run) — fail-closed for CI, quiet for local first-runs.
 */
/**
 * Snapshot every `kit standards` dimension (general + specific + plugins + platform)
 * into the given baseline object and return the total number of findings frozen.
 * Shared by `kit baseline freeze` and `kit standards freeze` so the two never drift.
 */
async function freezeStandardsBaseline(baseline: Baseline, cwd: string): Promise<number> {
  const { collectStandardsKeys } = await import("./check-standards.js");
  const { collectSpecificKeys, SPECIFIC_LANGUAGES } = await import("./check-standards-specific.js");
  const { collectPluginKeys, DEFAULT_PLUGIN_DIR } = await import("./standards-plugins.js");
  const { collectMjsPluginKeys } = await import("./standards-plugins-exec.js");
  const { collectPlatformKeys } = await import("./check-standards-platform.js");
  const { detectStack } = await import("./stack-detector.js");
  const { baselineSet } = await import("./baseline.js");
  const cfg = await loadConfig(resolveConfigPath()).catch(
    () => ({}) as Awaited<ReturnType<typeof loadConfig>>,
  );

  const general = await collectStandardsKeys(cwd);
  baselineSet(baseline, "standards", "complexity", general.complexity);
  baselineSet(baseline, "standards", "duplication", general.duplication);
  baselineSet(baseline, "standards", "size", general.size);

  const lang = (await detectStack(cwd)).language;
  let specificCount = 0;
  if (SPECIFIC_LANGUAGES.includes(lang)) {
    const keys = await collectSpecificKeys(cwd, lang);
    baselineSet(baseline, "standards", `specific/${lang}`, keys);
    specificCount = keys.length;
  }

  const dirs =
    cfg.standards?.plugins?.dirs && cfg.standards.plugins.dirs.length > 0
      ? cfg.standards.plugins.dirs
      : [DEFAULT_PLUGIN_DIR];
  const pluginKeys = [
    ...collectPluginKeys(cwd, lang, dirs),
    ...(await collectMjsPluginKeys(cwd, lang, dirs)),
  ];
  baselineSet(baseline, "standards", "plugins", pluginKeys);

  const platformKeys = await collectPlatformKeys(cwd);
  baselineSet(baseline, "standards", "platform", platformKeys);

  return (
    general.complexity.length +
    general.duplication.length +
    general.size.length +
    specificCount +
    pluginKeys.length +
    platformKeys.length
  );
}

/** `kit standards freeze` — snapshot ONLY the standards dimensions into the baseline. */
async function cmdStandardsFreeze(): Promise<boolean> {
  const { loadBaseline, saveBaseline, BASELINE_FILE } = await import("./baseline.js");
  const baseline = await loadBaseline();
  const total = await freezeStandardsBaseline(baseline, process.cwd());
  await saveBaseline(baseline);
  console.log(
    `${c.green}✓${c.reset} Wrote ${BASELINE_FILE} — ${total} standards finding(s) frozen (general + specific + plugins + platform).`,
  );
  console.log(`  Future \`kit standards\` runs gate only on NEW findings.`);
  return true;
}

async function cmdStandards(): Promise<boolean> {
  const sub = process.argv[3];
  if (sub === "freeze") return cmdStandardsFreeze();
  const enforce = hasFlag(process.argv, "--enforce");
  const jsonMode = hasFlag(process.argv, "--json");
  const category = flagValue(process.argv, "--category"); // general | specific | plugins | platform | <lang>
  const { BASELINE_FILE } = await import("./baseline.js");
  const { runStandardsGate } = await import("./standards-run.js");
  // The SAME orchestration the MCP `kit_standards` tool uses — no divergent gate.
  const {
    ok,
    checks: results,
    summary,
    baselineIgnored,
  } = await runStandardsGate({
    enforce,
    category,
  });
  if (baselineIgnored) {
    console.error(
      `${c.yellow}!${c.reset} ${BASELINE_FILE} ignored (${baselineIgnored}) — gating on all findings`,
    );
  }
  const gaps = results.filter((r) => r.didNotRun);
  if (jsonMode) {
    console.log(JSON.stringify({ ok, checks: results, summary }, null, 2));
    return ok;
  }
  console.log(
    `${c.bold}Standards${c.reset} ${c.dim}(general + per-language + plugins + platform — deterministic, zero-LLM)${c.reset}`,
  );
  for (const r of results) {
    const icon =
      r.status === "pass"
        ? `${c.green}✓${c.reset}`
        : r.status === "fail"
          ? `${c.red}✗${c.reset}`
          : r.status === "warn"
            ? `${c.yellow}!${c.reset}`
            : `${c.dim}-${c.reset}`;
    console.log(`  ${icon} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
    if (r.files) for (const f of r.files) console.log(`      ${c.dim}- ${f}${c.reset}`);
  }
  // Score over gates that ran, then setup gaps and findings called out separately so
  // neither is mistaken for the other.
  const scoreColor = summary.failed > 0 ? c.red : summary.findings > 0 ? c.yellow : c.green;
  console.log(
    `  ${scoreColor}score ${summary.score}${c.reset} gates passed` +
      `${summary.findings > 0 ? ` · ${summary.findings} with findings` : ""}` +
      `${gaps.length > 0 ? ` · ${c.dim}${gaps.length} setup gap(s) (not run)${c.reset}` : ""}`,
  );
  if (gaps.length > 0 && !enforce) {
    console.log(
      `  ${c.dim}setup gaps are un-provisioned tools, not failures — install them to enable those gates; --enforce fails CI on them${c.reset}`,
    );
  }
  return ok;
}

/**
 * `kit review` — meta-runner: check + design + standards in one shot.
 * Convenient single-command gate for AI agents and PR checks.
 */
async function cmdReview(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  let allOk = true;
  if (!jsonMode) console.log(`${c.bold}kit review${c.reset} — full repo audit\n`);

  if (!jsonMode) console.log(`${c.bold}=== check ===${c.reset}`);
  const checkOk = await cmdCheck();
  if (!checkOk) allOk = false;

  if (!jsonMode) console.log(`\n${c.bold}=== design ===${c.reset}`);
  const designOk = await cmdDesign();
  if (!designOk) allOk = false;

  if (!jsonMode) console.log(`\n${c.bold}=== standards ===${c.reset}`);
  const standardsOk = await cmdStandards();
  if (!standardsOk) allOk = false;

  if (!jsonMode) {
    console.log(
      `\n${c.bold}${allOk ? `${c.green}✓ review passed` : `${c.red}✗ review failed`}${c.reset}`,
    );
  }
  return allOk;
}

/**
 * `kit baseline freeze` — snapshot current warnings into .kit-baseline.json
 * so future runs only gate on net-new findings. Currently freezes:
 *   - tests.untested_files
 */
async function cmdBaseline(): Promise<boolean> {
  const sub = process.argv[3];
  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`${c.bold}kit baseline${c.reset} — freeze current warnings`);
    console.log("\nUsage:");
    console.log("  kit baseline freeze   Snapshot current findings as the new baseline");
    console.log("  kit baseline show     Print contents of .kit-baseline.json");
    return true;
  }

  const { loadBaseline, saveBaseline, baselineSet, BASELINE_FILE } = await import("./baseline.js");
  const baseline = await loadBaseline();

  if (sub === "show") {
    console.log(JSON.stringify(baseline, null, 2));
    return true;
  }

  if (sub !== "freeze") {
    console.error(`${c.red}Unknown subcommand: ${sub}${c.reset}`);
    return false;
  }

  const { findUntestedSources } = await import("./check-tests.js");
  const { collectDesignKeys } = await import("./check-design.js");
  const untested = await findUntestedSources();
  baselineSet(baseline, "tests", "untested_files", untested);
  const design = await collectDesignKeys();
  baselineSet(baseline, "design", "a11y", design.a11y);
  baselineSet(baseline, "design", "tokens", design.tokens);
  // All standards dimensions (general + specific + plugins + platform) via the shared helper.
  const standardsTotal = await freezeStandardsBaseline(baseline, process.cwd());
  await saveBaseline(baseline);
  console.log(
    `${c.green}✓${c.reset} Wrote ${BASELINE_FILE} — ${untested.length} untested file(s), ${design.a11y.length} a11y, ${design.tokens.length} design-token, ${standardsTotal} standards finding(s) frozen.`,
  );
  console.log(`  Future runs will gate only on NEW findings.`);
  return true;
}

async function cmdInstall(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());

  if (!config.tools || Object.keys(config.tools).length === 0) {
    console.log(`${c.dim}No tools configured in ${KIT_FILE}${c.reset}`);
    return true;
  }

  const toolsConfig = config.tools;

  // WATERTIGHT: kit triages every third-party tool before installing it. The
  // `--no-triage` override is a deliberate, audited security action — it must
  // hold a one-shot elevation, or the install is refused.
  let skipTriage = false;
  if (hasFlag(process.argv, "--no-triage")) {
    const elev = await consumeElevation("tools.install.no-triage");
    if (!elev.ok) {
      console.error(`${c.red}✗ --no-triage refused: ${elev.reason}${c.reset}`);
      console.error(
        `${c.dim}Run 'kit auth elevate --scope tools.install.no-triage' first, or drop --no-triage to let triage run.${c.reset}`,
      );
      return false;
    }
    skipTriage = true;
    console.log(
      `${c.yellow}⚠ --no-triage: triage gate bypassed (elevation consumed, audit-logged)${c.reset}`,
    );
  }

  console.log(`${c.bold}${c.cyan}Installing tools via mise...${c.reset}\n`);

  return await withGovernance(
    config,
    {
      operation: "tools.install",
      operationType: "write",
      metadata: {
        tools: Object.keys(toolsConfig),
        skipTriage,
      },
    },
    async () => {
      const results = await installTools(toolsConfig, undefined, { skipTriage });
      let allOk = true;

      for (const r of results) {
        const icon =
          r.action === "failed"
            ? `${c.red}✗${c.reset}`
            : r.action === "blocked"
              ? `${c.yellow}⛔${c.reset}`
              : `${c.green}✓${c.reset}`;
        const label =
          r.action === "already_ok"
            ? `${c.dim}already installed${c.reset}`
            : r.action === "installed"
              ? `${c.green}installed${c.reset}`
              : r.action === "blocked"
                ? `${c.yellow}blocked by triage${c.reset}`
                : `${c.red}failed${c.reset}`;
        console.log(`  ${icon} ${r.name}  ${label}  ${c.dim}${r.detail}${c.reset}`);
        if (r.action === "failed" || r.action === "blocked") allOk = false;
      }

      console.log();
      return allOk;
    },
  );
}

/**
 * Self-healing scanner preflight for `kit check` / `kit ci`. Installs any security
 * scanner declared in `.kit.toml [tools]` but not yet present, so the scan actually
 * RUNS in an ephemeral environment instead of reporting the scanner missing (which
 * fails the strict gate). Complements `kit install` at env-setup — this backstops
 * the case where setup did not run. Opt out with `--no-auto-install` /
 * `KIT_CHECK_NO_AUTOINSTALL`; skipped when air-gapped. installTools is triage-gated
 * and read-only-aware, so this can never run an untriaged binary or write in
 * --read-only mode. Best-effort: a failed install just leaves the check to fail closed.
 */
async function autoInstallScanners(config: kitConfig, live: boolean): Promise<void> {
  if (!config.tools) return;
  const { ensureScannersInstalled } = await import("./install.js");
  const { resolveAirGap } = await import("./airgap/config.js");
  const disabled =
    hasFlag(process.argv, "--no-auto-install") ||
    ["1", "true", "yes"].includes(
      (process.env.KIT_CHECK_NO_AUTOINSTALL ?? "").trim().toLowerCase(),
    );
  const results = await ensureScannersInstalled(config.tools, {
    disabled,
    airGapped: resolveAirGap(config.air_gap, process.env).enabled,
  });
  const newly = results.filter((r) => r.action === "installed");
  if (live && newly.length) {
    console.log(
      `  ${c.green}✓${c.reset} ${c.dim}auto-installed ${newly
        .map((r) => r.name)
        .join(", ")} so its scan can run${c.reset}`,
    );
  }
}

async function ensureSecretsBackend(config: kitConfig): Promise<boolean> {
  // Some secret backends (1Password) need a separate interactive signin before
  // any of the per-key `op read` calls can succeed. Run it once up front so
  // `kit setup` produces a usable .env.local in a single pass.
  if (config.secrets?.store !== "1password") return true;

  const { mode, hint } = await detect1PasswordMode();

  // Already authenticated via the desktop app or a service-account token —
  // nothing else to do, the per-key `op read` calls will inherit auth.
  if (mode === "service-account" || mode === "desktop-integration") {
    return true;
  }

  if (mode === "not-installed") {
    console.log(`${c.yellow}1Password CLI not installed.${c.reset}`);
    console.log(`${c.dim}${hint}${c.reset}\n`);
    return false;
  }

  if (mode === "no-account") {
    console.log(`${c.yellow}No 1Password account configured.${c.reset}`);
    console.log(`${c.dim}${hint}${c.reset}\n`);
    return false;
  }

  // mode === "eval-signin": op exists, accounts exist, but no live session.
  // We can't propagate OP_SESSION_<shorthand> from a child spawn back into
  // the parent shell, so attempting `op signin` here would print eval-able
  // text but leave the running kit invocation without auth. Explain the
  // two viable paths to the user instead.

  if (isNonInteractive()) {
    console.log(
      `${c.yellow}1Password not signed in — non-interactive mode can't recover.${c.reset}`,
    );
    console.log(`${c.dim}${hint}${c.reset}\n`);
    return false;
  }

  console.log(`${c.yellow}1Password not signed in.${c.reset}`);
  console.log(`${c.dim}${hint}${c.reset}`);
  console.log(
    `${c.dim}For headless / CI: set ${c.bold}OP_SERVICE_ACCOUNT_TOKEN${c.reset}${c.dim} instead.${c.reset}\n`,
  );

  // Last resort — try `op signin` interactively. With desktop-integration
  // enabled mid-session this will succeed; with eval-only setups it will
  // print export commands the user can copy.
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawnChild("op", ["signin"], {
      stdio: "inherit",
      env: { ...process.env },
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });

  if (!ok) return false;

  const verify = await check1PasswordStatus();
  if (!verify.authenticated) {
    console.log(`${c.yellow}Still not authenticated — see hint above.${c.reset}\n`);
    return false;
  }
  console.log(`${c.green}✓ 1Password authenticated${c.reset}\n`);
  return true;
}

async function cmdLogin(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());

  // Per-service control: `--service <name>` narrows the login to a single
  // configured service. Useful when one auth flakes and you don't want to
  // re-run all 8 services again. `--retry-count N` retries the same login
  // command on failure with exponential backoff. `--force-reauth` is
  // accepted but currently a no-op flag the CLI layer surfaces — the
  // underlying service-adapter is responsible for honoring it (most just
  // re-run their login command idempotently anyway).
  const args = process.argv.slice(3);
  const serviceFilter = flagValue(args, "--service");
  const retryIdx = args.indexOf("--retry-count");
  const retryCount =
    retryIdx >= 0 && args[retryIdx + 1] ? Math.max(0, parseInt(args[retryIdx + 1]!, 10) || 0) : 0;

  const backendOk = await ensureSecretsBackend(config);

  if (!config.services || Object.keys(config.services).length === 0) {
    console.log(`${c.dim}No services configured in ${KIT_FILE}${c.reset}`);
    return backendOk;
  }

  // Narrow services config to the requested one, if any.
  let servicesConfig = config.services;
  if (serviceFilter) {
    if (!servicesConfig[serviceFilter]) {
      console.error(
        `${c.red}No service "${serviceFilter}" in .kit.toml. Available: ${Object.keys(servicesConfig).join(", ")}${c.reset}`,
      );
      return false;
    }
    servicesConfig = { [serviceFilter]: servicesConfig[serviceFilter]! };
    console.log(
      `${c.dim}Filtering to service "${serviceFilter}"${retryCount ? ` (retries=${retryCount})` : ""}${c.reset}`,
    );
  }

  // `--plan`: read-only. Show the resolved auth strategy per service (vault /
  // interactive / capture, + passkey warnings) without logging in to anything.
  if (hasFlag(args, "--plan")) {
    const plan = resolveAllAuth(servicesConfig);
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(plan, null, 2));
      return true;
    }
    console.log(`${c.bold}auth plan${c.reset}  ${c.dim}${plan.length} service(s)${c.reset}`);
    for (const p of plan) {
      const tag = p.passkey
        ? `${c.yellow}${p.strategy} ⚿${c.reset}`
        : `${c.cyan}${p.strategy}${c.reset}`;
      console.log(`  ${tag}  ${p.name}  ${c.dim}${p.instruction}${c.reset}`);
    }
    return true;
  }

  console.log(`${c.bold}${c.cyan}Authenticating services...${c.reset}`);

  return await withGovernance(
    config,
    {
      operation: "services.login",
      operationType: "write",
      metadata: {
        services: Object.keys(servicesConfig),
      },
    },
    async () => {
      let results = await loginServices(servicesConfig);
      // Retry-loop: re-run failing services up to retryCount times with
      // exponential backoff (250ms, 500ms, 1s, ...). Each attempt only
      // re-tries services that were marked failed/login_unverified.
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        const failed = results.filter(
          (r) => r.action === "failed" || r.action === "login_unverified",
        );
        if (failed.length === 0) break;
        const backoffMs = 250 * 2 ** (attempt - 1);
        console.log(
          `${c.dim}Retrying ${failed.length} service(s) in ${backoffMs}ms (attempt ${attempt}/${retryCount})...${c.reset}`,
        );
        await new Promise((res) => setTimeout(res, backoffMs));
        const retryConfig: typeof servicesConfig = {};
        for (const f of failed) {
          if (servicesConfig[f.name]) retryConfig[f.name] = servicesConfig[f.name]!;
        }
        const retryResults = await loginServices(retryConfig);
        // Merge: replace failed entries with their retry outcome.
        const updated = new Map(results.map((r) => [r.name, r]));
        for (const r of retryResults) updated.set(r.name, r);
        results = Array.from(updated.values());
      }
      let allOk = true;

      console.log();
      for (const r of results) {
        const icon =
          r.action === "failed"
            ? `${c.red}✗${c.reset}`
            : r.action === "login_unverified"
              ? `${c.yellow}?${c.reset}`
              : r.action === "manual"
                ? `${c.yellow}!${c.reset}`
                : `${c.green}✓${c.reset}`;
        const label =
          r.action === "already_authenticated"
            ? `${c.dim}already authenticated${c.reset}`
            : r.action === "logged_in"
              ? `${c.green}logged in${c.reset}`
              : r.action === "login_unverified"
                ? `${c.yellow}login unverified${c.reset}`
                : r.action === "manual"
                  ? `${c.yellow}manual${c.reset}`
                  : `${c.red}failed${c.reset}`;
        console.log(`  ${icon} ${r.name}  ${label}  ${c.dim}${r.detail}${c.reset}`);
        if (r.action === "failed" || r.action === "login_unverified") allOk = false;
      }

      console.log();
      return allOk && backendOk;
    },
  );
}

async function cmdSkills(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());

  if (!config.skills) {
    console.log(`${c.dim}No skills configured in ${KIT_FILE}${c.reset}`);
    return true;
  }

  const registry = config.skills.registry ?? "clawhub";
  console.log(`${c.bold}${c.cyan}Skills${c.reset}  ${c.dim}(registry: ${registry})${c.reset}\n`);

  const results = await checkSkills(config.skills);

  if (results.length === 0) {
    console.log(`${c.dim}No skills listed in ${KIT_FILE}${c.reset}`);
    return true;
  }

  const nameWidth = Math.max(12, ...results.map((r) => r.name.length)) + 2;

  for (const r of results) {
    const icon = r.installed
      ? `${c.green}✓${c.reset}`
      : r.required
        ? `${c.red}✗${c.reset}`
        : `${c.yellow}!${c.reset}`;
    const name = r.name + " ".repeat(Math.max(0, nameWidth - r.name.length));
    const tag = r.required ? `${c.dim}[required]${c.reset}` : `${c.dim}[optional]${c.reset}`;
    const status = r.installed ? `${c.green}installed${c.reset}` : `${c.red}missing${c.reset}`;
    console.log(`  ${icon} ${name} ${tag} ${status}  ${c.dim}${r.versionSpec}${c.reset}`);
  }

  const missing = results.filter((r) => !r.installed);
  if (missing.length > 0) {
    console.log();
    console.log(`${c.bold}To install missing skills:${c.reset}`);
    for (const m of missing) {
      console.log(`  ${c.cyan}openclaw install ${registry}/${m.name}${c.reset}`);
    }
  }

  console.log();
  const requiredMissing = results.filter((r) => r.required && !r.installed);
  return requiredMissing.length === 0;
}

async function cmdEscalate(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());

  return await withGovernance(
    config,
    {
      operation: "escalate",
      operationType: "read",
      metadata: {},
    },
    async () => {
      const toolResults = config.tools ? await checkTools(config.tools) : [];
      const serviceResults = config.services ? await checkServices(config.services) : [];
      const secretResults = config.secrets
        ? await checkSecrets(config.secrets)
        : { templateExists: null, keys: [] };

      const items = collectEscalations(toolResults, serviceResults, secretResults.keys);

      if (items.length === 0) {
        console.log(`${c.green}All checks passed — nothing to escalate.${c.reset}`);
        return true;
      }

      const message = formatEscalationMessage(items, process.cwd());
      console.log(`${c.bold}${c.yellow}Escalation summary${c.reset}\n`);
      console.log(message);

      // Write to file for easy copy/paste or piping
      const { writeFile } = await import("node:fs/promises");
      const escalationPath = resolve(process.cwd(), ".kit-escalation.txt");
      await writeFile(escalationPath, message, "utf-8");
      console.log(`${c.dim}Written to ${escalationPath}${c.reset}`);
      console.log(`${c.dim}Send this to the project owner for manual resolution.${c.reset}\n`);

      return false;
    },
  );
}

/**
 * Run a command string from a `.kit.toml [setup]` field. These are commands the
 * user configured themselves, but kit's exec invariant forbids a shell — so we
 * tokenize like a shell (respecting quotes, so `--arg "a b"` stays one argument)
 * and REFUSE anything with shell operators rather than mis-running it. Returns
 * true on exit 0.
 */
async function runConfiguredCommand(label: string, cmdStr: string): Promise<boolean> {
  if (/[&|;<>`$()]/.test(cmdStr)) {
    console.log(
      `  ${c.yellow}!${c.reset} ${label}: ${c.dim}has shell operators — run it yourself: ${c.reset}${c.bold}${cmdStr}${c.reset}`,
    );
    return false;
  }
  let commandArgs: string[];
  try {
    const { shellSplit } = await import("./utils/shellSplit.js");
    commandArgs = shellSplit(cmdStr);
  } catch {
    console.log(
      `  ${c.yellow}!${c.reset} ${label}: ${c.dim}unbalanced quotes — run it yourself: ${c.reset}${c.bold}${cmdStr}${c.reset}`,
    );
    return false;
  }
  console.log(`  ${c.dim}$ ${cmdStr}${c.reset}`);
  const res = await executeCommand({ commandArgs, cwd: process.cwd() });
  if (res.exitCode === 0) {
    console.log(`  ${c.green}✓${c.reset} ${label}`);
    return true;
  }
  console.log(`  ${c.red}✗${c.reset} ${label} ${c.dim}(exit ${res.exitCode})${c.reset}`);
  return false;
}

async function cmdSetup(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit setup${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const config = await loadConfig(resolveConfigPath());

  // Setup MODE — a named preset over the knobs below (flag > [setup].mode > full).
  // full ≡ the historical behavior; other modes gate which steps run + the posture.
  const { profile, requested, recognized } = resolveMode(
    flagValue(process.argv, "--mode"),
    config.setup?.mode,
  );
  if (requested && !recognized) {
    console.log(
      `${c.yellow}!${c.reset} unknown mode "${requested}" — using "full". Modes: ${MODE_NAMES.join(", ")}\n`,
    );
  }
  console.log(
    `${c.dim}mode:${c.reset} ${c.bold}${profile.mode}${c.reset} ${c.dim}— ${profile.blurb}${c.reset}`,
  );
  if (profile.readOnly) {
    process.env.KIT_READ_ONLY = "1"; // review: refuse writes; only config + verify run
    console.log(`${c.dim}read-only review — no installs / logins / secrets / hooks.${c.reset}`);
  }
  console.log();

  // Network posture (connected vs air-gapped enclave): the mode can force it,
  // otherwise prompt. Writes [air_gap]; idempotent — skips if already declared.
  await offerPosture(resolveConfigPath(), config, isNonInteractive(), profile.posture);

  // Recommended profile: an explicit flag always wins; otherwise ASK
  // interactively (the flag is just the scriptable answer to this question).
  // CI/agents without a flag get the core setup — we never silently wire global
  // ~/.claude hooks or the repo's git hooks without an explicit yes.
  let recommended: boolean;
  if (hasFlag(process.argv, "--recommended")) {
    recommended = true;
  } else if (hasFlag(process.argv, "--minimal") || hasFlag(process.argv, "--no-recommended")) {
    recommended = false;
  } else if (isNonInteractive()) {
    recommended = profile.recommended;
  } else {
    recommended = await promptConfirm(
      `Use the recommended profile? Wires cross-harness memory hooks (in ~/.claude) + git secret-scan${config.context ? " + context-check" : ""} gates after the core steps. [Y/n] `,
      10000,
      profile.recommended,
    );
    console.log();
  }

  if (recommended) {
    console.log(
      `${c.dim}Recommended profile on — memory + git hooks wired after the core steps.${c.reset}\n`,
    );
  }

  // Step 1: Install (skipped by modes that don't install tools — agent/review/minimal)
  let installOk = true;
  if (profile.install) {
    console.log(`${c.bold}[1/6] Install${c.reset}`);
    installOk = await cmdInstall();

    if (!installOk) {
      console.log(`${c.red}Install failed — stopping setup.${c.reset}`);
      console.log(
        `${c.dim}Fix the issues above and run ${c.reset}${c.bold}kit setup${c.reset}${c.dim} again.${c.reset}`,
      );
      return false;
    }

    // Project dependencies. cmdInstall above provisions the TOOLCHAIN (node, pnpm,
    // … via mise); now install the project's own deps so the repo actually works
    // after setup. The generated [setup].install was never executed before — kit
    // installed the toolchain but left node_modules absent.
    if (config.setup?.install) {
      await runConfiguredCommand("deps installed", config.setup.install);
    }
  }

  // Step 2: Git Hooks
  if (profile.hooks && config.hooks && Object.keys(config.hooks).length > 0 && isGitRepository()) {
    console.log(`${c.bold}[2/6] Git Hooks${c.reset}`);
    await cmdHooks();
    console.log();
  }

  // Step 3: Login (skipped in airgap/ci/agent/review/minimal — those resolve from a vault)
  let loginOk = true;
  if (profile.login) {
    console.log(`${c.bold}[3/6] Login${c.reset}`);
    loginOk = await cmdLogin();

    if (!loginOk) {
      console.log(`${c.yellow}Some logins failed — continuing with secrets + verify.${c.reset}\n`);
    }
  }

  // Step 4: Secrets (skipped only by review — read-only)
  let secretsOk = true;
  if (profile.secrets) {
    console.log(`${c.bold}[4/6] Secrets${c.reset}`);

    // Harden .gitignore BEFORE secrets are materialized. kit's headline is
    // "secret-safe", but cmdSecrets writes .env.local below — if the repo's
    // .gitignore doesn't already cover it, the next `git add .` stages real
    // secrets. Patching is a non-destructive, repo-local append, so we do it by
    // default and announce it (standalone `kit security check-gitignore --fix`
    // remains for the manual path).
    if (isGitRepository()) {
      const gi = await checkGitignore(process.cwd());
      if (gi.missingPatterns.length > 0) {
        const patched = await patchGitignore(process.cwd());
        const names = gi.missingPatterns
          .slice(0, 3)
          .map((m) => m.pattern)
          .join(", ");
        console.log(
          `  ${c.green}✓${c.reset} hardened .gitignore ${c.dim}(+${patched.added}: ${names}${gi.missingPatterns.length > 3 ? ", …" : ""}) — review + commit it${c.reset}`,
        );
      }
    }

    secretsOk = await cmdSecrets();
  }

  // [setup].migrate / .seed are intentionally NOT auto-run: a configured migrate
  // (`supabase db push`, `prisma migrate deploy`) can mutate a linked — possibly
  // production — database. Run only on explicit opt-in; otherwise surface the
  // exact command so applying it stays a deliberate human action.
  if (config.setup?.migrate || config.setup?.seed) {
    if (hasFlag(process.argv, "--with-migrate")) {
      console.log(`${c.bold}[+] Migrate / seed${c.reset}`);
      if (config.setup.migrate) await runConfiguredCommand("migrate", config.setup.migrate);
      if (config.setup.seed) await runConfiguredCommand("seed", config.setup.seed);
      console.log();
    } else {
      const cmds = [config.setup.migrate, config.setup.seed].filter(Boolean).join("  ·  ");
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}Skipping migrate/seed (may mutate a real DB). Run deliberately: ${c.reset}${c.bold}${cmds}${c.reset}${c.dim}  or  ${c.reset}${c.bold}kit setup --with-migrate${c.reset}`,
      );
    }
  }

  // Step 5: Agent config — teach the present agent(s) to use kit. Idempotent;
  // only writes a managed block, so re-running setup leaves it unchanged.
  console.log(`${c.bold}[5/6] Agent config${c.reset}`);
  const agentResults = await writeAgentConfig();
  for (const r of agentResults) {
    if (r.action === "failed") {
      console.log(`  ${c.yellow}!${c.reset} ${r.agent}: ${r.detail}`);
    } else {
      const mark = r.action === "unchanged" ? `${c.dim}=` : `${c.green}✓`;
      console.log(`  ${mark}${c.reset} ${r.agent} ${c.dim}→ ${r.file} (${r.action})${c.reset}`);
    }
  }
  // Let the agent actually run kit: grant the read-only kit commands (same as
  // `kit agent-config`). Without this the agent hits the permission wall.
  const perms = await installKitPermissions();
  if (perms.action === "created" || perms.action === "updated") {
    console.log(
      `  ${c.green}✓${c.reset} allowed ${perms.added.length} read-only kit command(s) ${c.dim}→ ${perms.file}${c.reset}`,
    );
  }
  // Install the ENFORCEMENT gates too — a block that only advises leaves the floor
  // out, which the gate-liveness check (rightly) fails. `kit agent teach` installs
  // these by default; setup must too, so a fresh setup produces a complete floor.
  for (const { agent, result } of await installAllInstallGates()) {
    if (result.action === "created" || result.action === "updated") {
      console.log(`  ${c.green}✓${c.reset} ${agent} gate ${c.dim}→ ${result.file}${c.reset}`);
    }
  }
  console.log();

  // Step 6: Verify
  console.log(`${c.bold}[6/6] Verify${c.reset}`);
  const verifyOk = await cmdCheck();

  // Recommended hardening: memory hooks + git hooks (opt-in via --recommended).
  if (recommended) {
    console.log(`\n${c.bold}[+] Recommended hardening${c.reset}`);
    const h = await applyRecommendedHardening(config);
    for (const e of h.memory.added)
      console.log(`  ${c.green}✓${c.reset} memory hook ${c.dim}${e}${c.reset}`);
    if (h.memory.added.length === 0)
      console.log(`  ${c.dim}= memory hooks already wired${c.reset}`);
    if (!h.memory.resolved) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}memory hooks use a bare \`kit\` (kit not resolvable to an absolute path)${c.reset}`,
      );
    }
    for (const r of h.hooks) {
      const icon =
        r.action === "failed"
          ? `${c.red}✗`
          : r.action === "skipped"
            ? `${c.yellow}!`
            : `${c.green}✓`;
      console.log(`  ${icon}${c.reset} git ${r.hookName} ${c.dim}(${r.action})${c.reset}`);
    }
    console.log();
  }

  // Project verify (e.g. the configured build). Distinct from cmdCheck above,
  // which audits setup STATE — this proves the app actually builds. Run last so
  // deps + secrets are in place.
  let setupVerifyOk = true;
  if (config.setup?.verify) {
    console.log(`\n${c.bold}[+] Verify build${c.reset}`);
    setupVerifyOk = await runConfiguredCommand(config.setup.verify, config.setup.verify);
    console.log();
  }

  const allOk = installOk && loginOk && secretsOk && verifyOk && setupVerifyOk;

  if (allOk) {
    console.log(`${c.bold}${c.green}Setup complete — you're ready to go! ✓${c.reset}\n`);
  } else {
    console.log(
      `${c.bold}${c.yellow}Setup finished with issues. Run ${c.reset}${c.bold}kit check${c.reset}${c.yellow} to see what's left.${c.reset}\n`,
    );
  }

  return allOk;
}

async function cmdAgentConfig(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit agent-config${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const targets = detectAgentTargets();
  console.log(
    `${c.dim}Teaching ${targets.map((t) => `${c.reset}${c.bold}${t.agent}${c.reset}${c.dim}`).join(", ")} to use kit ` +
      `(managed block in their rules file).${c.reset}\n`,
  );

  const results = await writeAgentConfig();
  // Aider needs a bespoke installer (CONVENTIONS.md + a `read:` entry in
  // .aider.conf.yml — it auto-reads no rules file), so it's not an AGENT_TARGETS row.
  const aider = await installAiderRules();
  if (aider.detail !== "no Aider project detected") results.push(aider);
  let failed = false;
  for (const r of results) {
    if (r.action === "failed") {
      failed = true;
      console.log(`  ${c.red}✗${c.reset} ${r.agent} (${r.file}): ${r.detail}`);
    } else {
      const mark = r.action === "unchanged" ? `${c.dim}=` : `${c.green}✓`;
      console.log(`  ${mark}${c.reset} ${r.agent} ${c.dim}→ ${r.file} (${r.action})${c.reset}`);
    }
  }
  // Let the agent actually RUN kit: grant read-only kit commands in
  // .claude/settings.json, so they don't hit the permission wall in auto mode.
  const perms = await installKitPermissions();
  if (perms.action === "created" || perms.action === "updated") {
    console.log(
      `\n  ${c.green}✓${c.reset} allowed ${c.bold}${perms.added.length}${c.reset} read-only kit command(s) in ${c.dim}${perms.file}${c.reset} ${c.dim}(so the agent can run them without a prompt)${c.reset}`,
    );
  } else if (perms.action === "unchanged") {
    console.log(`\n  ${c.dim}= read-only kit commands already allowed in ${perms.file}${c.reset}`);
  } else if (perms.action === "failed") {
    console.log(`\n  ${c.yellow}!${c.reset} could not update ${perms.file}: ${perms.detail}`);
  }
  // Default-ON: the true blocking gates (PreToolUse hooks) — un-triaged installs
  // and plaintext secrets aimed at .env* are blocked BEFORE they run/land. The
  // rules block above only advises; these enforce. An instruction the agent can
  // ignore is a false green, so enforcement is the default; --no-install-gate
  // opts out (--install-gate is still accepted for backward compatibility).
  if (!hasFlag(process.argv, "--no-install-gate")) {
    console.log(
      `\n  ${c.bold}PreToolUse gates${c.reset} ${c.dim}(block un-triaged installs + plaintext .env* secrets before they happen; --no-install-gate to skip):${c.reset}`,
    );
    for (const { agent, result } of await installAllInstallGates()) {
      if (result.action === "created" || result.action === "updated") {
        console.log(
          `    ${c.green}✓${c.reset} ${agent} ${c.dim}→ ${result.file}${result.detail ? ` (${result.detail})` : ""}${c.reset}`,
        );
      } else if (result.action === "unchanged") {
        console.log(`    ${c.dim}= ${agent} already wired (${result.file})${c.reset}`);
      } else {
        console.log(`    ${c.dim}· ${agent} skipped: ${result.detail ?? result.action}${c.reset}`);
      }
    }
  }
  console.log(
    `\n${c.dim}Blocks regenerate in place on re-run; edit outside the markers freely. ` +
      `Mutating kit commands (secrets/fix/hooks) still prompt by design.${c.reset}`,
  );
  console.log(
    `\n${c.bold}Agent support${c.reset} ${c.dim}(what kit wires up per agent):${c.reset}\n` +
      `  ${c.dim}· Memory index: Claude Code, Codex, Cursor, Cline, Gemini, Continue, Amazon Q, Kiro, Factory Droid, Aider, Antigravity, OpenCode${c.reset}\n` +
      `  ${c.dim}· "use kit" rules block: Claude Code, Codex, Cursor, Cline, OpenCode${c.reset}\n` +
      `  ${c.dim}· Config/secret audit (kit agent-audit): Claude Code, Codex, Cursor, OpenCode (+ generic .mcp.json)${c.reset}\n` +
      `  ${c.dim}· Permission allowlist + auto-capture hooks: Claude Code${c.reset}\n` +
      `  ${c.dim}· Blocking install-gate: Claude Code, Codex, Amazon Q, Kiro, Factory Droid, Augment, Antigravity, Gemini CLI, Cursor (hooks), OpenCode (plugin), Cline (PreToolUse shim); Continue has no gate surface (#146)${c.reset}\n` +
      `  ${c.dim}The agent-agnostic enforcement floor is git hooks (${c.reset}${c.bold}kit hooks${c.reset}${c.dim}); the rules block only advises.${c.reset}`,
  );
  return !failed;
}

async function cmdGovernance(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());
  const governanceConfig = await mergeGovernanceConfigAsync(config.governance);

  console.log(`${c.bold}${c.cyan}Governance Status${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // Display governance configuration
  console.log(formatGovernanceStatus(governanceConfig));
  console.log();

  // Check revocation status
  if (governanceConfig.revocation.enabled) {
    const revoked = await checkRevocationStatus(config.governance);
    const icon = revoked ? `${c.red}✗${c.reset}` : `${c.green}✓${c.reset}`;
    const status = revoked ? `${c.red}REVOKED${c.reset}` : `${c.green}Active${c.reset}`;
    console.log(`  ${icon} Access Status: ${status}`);
  }

  // Display budget status
  if (governanceConfig.agent.max_tokens_per_day || governanceConfig.agent.max_operations_per_hour) {
    console.log();
    const budgetStatus = await getBudgetStatus(config.governance);
    console.log(formatBudgetStatus(budgetStatus));
  }

  // Display agent info
  if (governanceConfig.agent.id || governanceConfig.agent.name) {
    console.log();
    console.log("Agent Information");
    console.log("─".repeat(50));
    if (governanceConfig.agent.name) {
      console.log(`Name: ${governanceConfig.agent.name}`);
    }
    if (governanceConfig.agent.id) {
      console.log(`ID: ${governanceConfig.agent.id}`);
    }
  }

  console.log();
  return true;
}

/**
 * Detect the npm global-install permission failure (EACCES / EPERM writing into
 * a root-owned prefix). This is the #1 cause of `npm i -g` failures and the raw
 * "Command failed" message gives no hint, so we sniff the combined message +
 * stderr for the well-known signatures.
 */
export function isNpmPermissionError(text: string): boolean {
  return /\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|EACCES: permission/i.test(
    text,
  );
}

/**
 * The documented remediation for an `npm -g` EACCES: switch to a user-owned
 * prefix instead of `sudo` (sudo-installed globals leave root-owned files that
 * break every later install). Returns ready-to-print lines.
 */
export function npmPermissionRemediation(): string[] {
  return [
    `${c.yellow}This is an npm permission error (EACCES) — npm cannot write to its global prefix.${c.reset}`,
    `${c.dim}Do NOT use sudo. Point npm at a user-owned prefix, then re-run the upgrade:${c.reset}`,
    `  ${c.bold}npm config set prefix ~/.npm-global${c.reset}`,
    `  ${c.bold}export PATH=~/.npm-global/bin:$PATH${c.reset}  ${c.dim}# add to your ~/.zshrc or ~/.bashrc${c.reset}`,
    `  ${c.bold}kit upgrade --self${c.reset}`,
  ];
}

/**
 * Governed self-upgrade: kit triages its OWN npm package before installing a new
 * version of itself. WATERTIGHT — an untriaged kit is never installed; offline /
 * triage-unavailable → blocked (fail-closed). The raw `npm i -g sandstream-kit`
 * is still available to the user, but that path is outside kit's governance.
 */
async function selfUpgrade(): Promise<boolean> {
  const { gateInstall } = await import("./triage-gate.js");
  console.log(`${c.dim}Triaging sandstream-kit before upgrading itself…${c.reset}`);
  const verdict = await gateInstall("npm:sandstream-kit");
  if (verdict.decision === "blocked") {
    console.error(`${c.red}✗ self-upgrade blocked: ${verdict.reason}${c.reset}`);
    console.error(
      `${c.dim}kit will not install an untriaged version of itself. Get online with the triage skill installed, then retry.${c.reset}`,
    );
    return false;
  }
  console.log(`${c.green}✓${c.reset} ${verdict.reason} — upgrading…\n`);
  try {
    const { exec } = await import("./utils/exec.js");
    await exec("npm", ["install", "-g", "sandstream-kit@latest"], {
      timeout: 180_000,
      env: { ...process.env },
    });
    console.log(
      `\n${c.green}${c.bold}✓ kit upgraded${c.reset} — run ${c.bold}kit --version${c.reset} to confirm.`,
    );
    return true;
  } catch (err: unknown) {
    const { redactSecrets } = await import("./utils/redactSecrets.js");
    const msg = err instanceof Error ? err.message : String(err);
    // promisified execFile attaches the child's stderr to the error object
    const stderr =
      typeof (err as { stderr?: unknown })?.stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
    const combined = `${msg}\n${stderr}`;
    console.error(`${c.red}✗ npm install failed: ${redactSecrets(msg.split("\n")[0])}${c.reset}`);
    if (stderr.trim()) {
      console.error(`${c.dim}${redactSecrets(stderr.trim())}${c.reset}`);
    }
    if (isNpmPermissionError(combined)) {
      console.error();
      for (const line of npmPermissionRemediation()) console.error(line);
    } else {
      console.error(
        `${c.dim}If this persists, install manually: ${c.reset}${c.bold}npm install -g sandstream-kit@latest${c.reset}`,
      );
    }
    return false;
  }
}

async function cmdUpgrade(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit upgrade${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (hasFlag(process.argv, "--self")) {
    return await selfUpgrade();
  }

  const config = await loadConfig(resolveConfigPath());

  // Update skills lock
  const skills: Record<string, string> = {};
  if (config.skills?.required) {
    Object.assign(skills, config.skills.required);
  }
  if (config.skills?.optional) {
    Object.assign(skills, config.skills.optional);
  }

  const kitMeta = await readkitMeta();
  await updateSkillsLock(skills, kitMeta?.name ? `${kitMeta.name}@${kitMeta.version}` : undefined);

  // Update CLI lock
  const tools: Record<
    string,
    { version: string; source: "mise" | "npm" | "pip" | "manual"; auth?: string }
  > = {};
  if (config.tools) {
    for (const [name, version] of Object.entries(config.tools)) {
      tools[name] = { version, source: "mise" };
    }
  }

  await updateCliLock(tools);

  console.log(`${c.green}✓${c.reset} Updated lock files from .kit.toml\n`);

  console.log(
    `${c.dim}Run ${c.reset}${c.bold}kit install${c.reset}${c.dim} to install updated tools${c.reset}`,
  );
  console.log(
    `${c.dim}Run ${c.reset}${c.bold}kit skills${c.reset}${c.dim} to check skill status${c.reset}\n`,
  );

  return true;
}

/**
 * Generate a `.kit.toml` when none exists: detect stack, surface plaintext
 * secrets, pick a secret backend, preview, and write. Returns "written" on
 * success, "abort-error" when config can't be generated (low-confidence +
 * non-interactive), or "abort-user" when the user declines the write.
 */
async function generateConfigFile(
  configPath: string,
  nonInteractive: boolean,
): Promise<"written" | "abort-error" | "abort-user"> {
  console.log(`${c.yellow}No .kit.toml found.${c.reset}\n`);

  const stack = await runStep("detect project stack", () => detectStack(process.cwd()));

  if (stack.confidence < 0.3 && nonInteractive) {
    console.error(
      `${c.red}✗ Stack detection confidence too low (${(stack.confidence * 100).toFixed(0)}%) — cannot auto-generate config in non-interactive mode.${c.reset}`,
    );
    console.error(`${c.dim}Create a .kit.toml manually or run 'kit init' interactively.${c.reset}`);
    return "abort-error";
  }

  const detectedLabel = [
    stack.language !== "unknown" ? stack.language : null,
    stack.framework ?? null,
    stack.services.length ? stack.services.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" / ");

  if (stack.language === "unknown") {
    console.log(`${c.dim}Could not detect project type — generating minimal config.${c.reset}\n`);
  } else {
    console.log(
      `  ${c.green}✓${c.reset} Detected: ${c.bold}${detectedLabel}${c.reset}  ${c.dim}(confidence: ${(stack.confidence * 100).toFixed(0)}%)${c.reset}`,
    );
    // P4 — turn the confidence signal into a guard. Mis-detections cluster in the low band
    // (~60%) while unambiguous stacks score 85–90%; when we're below that, say so and show how
    // to correct it, rather than committing a possibly-wrong language silently.
    if (stack.confidence < 0.7) {
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}Low confidence — if this is wrong, set the right language under ${c.reset}${c.bold}[project]${c.reset}${c.dim} in .kit.toml (a polyglot repo can carry several manifests).${c.reset}`,
      );
    }
    console.log();
  }

  // ── Plaintext-secrets scan ─────────────────────────────────────────────
  // Surface obvious credentials sitting in .env / package.json / scripts/
  // BEFORE wiring up the vault, so the choice of backend is informed.
  const plaintextHits = await scanPlaintextSecrets(process.cwd());
  if (plaintextHits.length > 0) {
    const totalFindings = plaintextHits.reduce((sum, h) => sum + h.findings.length, 0);
    console.log(
      `${c.red}⚠ Found ${totalFindings} plaintext secret(s) across ${plaintextHits.length} file(s):${c.reset}`,
    );
    for (const hit of plaintextHits) {
      const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
      console.log(`  ${c.dim}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
    }
    console.log(
      `${c.yellow}These should be migrated to a vault. ` +
        `Pick a secret backend below; we'll wire up the config now and you can run ` +
        `${c.bold}kit secrets migrate${c.reset}${c.yellow} after.${c.reset}\n`,
    );
  }

  // ── Secret-backend choice (interactive) ────────────────────────────────
  // Respect a backend the repo is already bound to (.infisical.json / doppler.yaml);
  // it becomes the default (and the non-interactive choice) instead of 1Password.
  const detectedStore = await detectSecretStore(async (p) => existsSync(resolve(process.cwd(), p)));
  let chosenStore: SecretsStore = detectedStore ?? "1password";
  if (detectedStore) {
    console.log(
      `  ${c.green}✓${c.reset} Detected ${c.bold}${detectedStore}${c.reset} config in repo — using it as the secret backend.\n`,
    );
  }
  if (!nonInteractive) {
    const opts = [
      { value: "1password", label: "1Password", hint: "interactive signin via op CLI" },
      { value: "infisical", label: "Infisical", hint: "self-hosted or cloud, token-based" },
      { value: "vault", label: "HashiCorp Vault", hint: "KV v2 paths" },
      { value: "aws-sm", label: "AWS Secrets Manager", hint: "IAM credentials required" },
      { value: "gcp-sm", label: "GCP Secret Manager", hint: "gcloud auth required" },
      { value: "azure-kv", label: "Azure Key Vault", hint: "az login required" },
      { value: "doppler", label: "Doppler", hint: "doppler login required" },
      { value: "bitwarden", label: "Bitwarden", hint: "bw login + unlock required" },
      { value: "env", label: "env (no vault)", hint: "not recommended — use only for local dev" },
    ].map((o) => ({ ...o, recommended: o.value === chosenStore }));
    chosenStore = (await promptSelect("Secret backend?", opts)) as SecretsStore;
    console.log();
  }

  // Detect a Dockerfile so generateToml can provision the trivy container/IaC
  // scanner only where it applies.
  const hasDockerfile =
    existsSync(resolve(process.cwd(), "Dockerfile")) ||
    existsSync(resolve(process.cwd(), "docker-compose.yml")) ||
    existsSync(resolve(process.cwd(), "compose.yml"));

  // Seed [secrets.keys] from an existing .env example so the project's real
  // secret contract isn't lost to just the detected services' template keys.
  let extraSecretKeys: string[] = [];
  for (const f of [".env.example", ".env.template", ".env.sample"]) {
    const p = resolve(process.cwd(), f);
    if (existsSync(p)) {
      extraSecretKeys = parseEnvTemplateKeys(readFileSync(p, "utf-8"));
      if (extraSecretKeys.length > 0) {
        console.log(
          `  ${c.green}✓${c.reset} Seeded ${extraSecretKeys.length} key(s) from ${c.bold}${f}${c.reset}\n`,
        );
      }
      break;
    }
  }

  const tomlContent = generateToml(stack, {
    secretsStore: chosenStore,
    hasDockerfile,
    extraSecretKeys,
  });

  // Show diff preview
  console.log(`${c.bold}Preview — .kit.toml${c.reset}\n`);
  for (const line of tomlContent.split("\n")) {
    if (line.trim() === "") {
      console.log();
    } else {
      console.log(`  ${c.green}+${c.reset} ${line}`);
    }
  }
  console.log();

  if (!nonInteractive) {
    // Prompt with 5-second default-yes timeout
    const accepted = await promptConfirm("Write this config? [Y/n] (auto-yes in 5s): ", 5000);
    if (!accepted) {
      console.log(`${c.dim}Aborted. Create .kit.toml manually when ready.${c.reset}`);
      return "abort-user";
    }
  }

  await writeFile(configPath, tomlContent, "utf-8");
  console.log(`  ${c.green}✓${c.reset} Generated ${c.bold}.kit.toml${c.reset}\n`);

  // Close the loop on the vault choice: tell the user exactly what `kit setup`
  // will provision and what they still have to do themselves (login is their
  // account action — kit guides it, never runs it).
  const meta = vaultMeta(chosenStore);
  if (meta) {
    console.log(`  ${c.dim}Secret backend: ${c.reset}${c.bold}${meta.label}${c.reset}`);
    if (meta.miseTool) {
      console.log(
        `    ${c.green}✓${c.reset} ${c.dim}${c.reset}${c.bold}kit setup${c.reset}${c.dim} will install its CLI via mise${c.reset}`,
      );
    }
    if (meta.loginCmd) {
      const steps = meta.initCmd ? `${meta.loginCmd} && ${meta.initCmd}` : meta.loginCmd;
      console.log(
        `    ${c.yellow}!${c.reset} ${c.dim}then authenticate (your account): ${c.reset}${c.bold}${steps}${c.reset}`,
      );
    }
    console.log();
  }

  return "written";
}

/**
 * Brownfield context-lock offer. If the repo already talks to gcloud / vercel /
 * github but `.kit.toml` declares no `[context]`, surface the detected
 * account+project and offer to lock it. kit does NOT install or authenticate
 * these (cloud env's job) — it locks which account+project this repo is bound to,
 * the exact pairing where cross-account contamination bugs hide. Default is NO:
 * the values are the currently-active CLI state, which is what the lock exists to
 * question, so the user must confirm they're right for THIS repo first.
 */
async function offerContextLock(configPath: string, nonInteractive: boolean): Promise<void> {
  const live = await gatherLive(process.cwd());
  if (!hasLockableContext(live)) return;
  // Never suggest locking a foreign active project (#251): when the repo's own
  // .firebaserc names its projects and the active gcloud context is not one of
  // them, warn with both values and suggest the REPO's project instead.
  const fb = gcpProjectMismatch(live, process.cwd());
  if (fb) {
    console.log(
      `${c.red}✗ active gcloud project ${c.bold}${fb.active}${c.reset}${c.red} is not one of this repo's declared project(s) ${c.bold}${fb.declared.join(", ")}${c.reset}${c.red} (.firebaserc)${c.reset}` +
        `\n  ${c.dim}suggesting the repo's own project below; switch the CLI with:${c.reset} gcloud config set project ${fb.declared[0]}\n`,
    );
    live.gcloud = { account: live.gcloud?.account ?? null, project: fb.declared[0] };
  }
  const block = suggestContextToml(live);
  if (!block.trim()) return;

  console.log(
    `${c.bold}Detected environment${c.reset} ${c.dim}— lock account+project so kit verifies the right one each session:${c.reset}\n`,
  );
  for (const line of block.split("\n")) {
    console.log(line.trim() === "" ? "" : `  ${c.dim}${line}${c.reset}`);
  }
  console.log(
    `\n${c.yellow}⚠ These are the currently-active CLI values — verify each is right for THIS repo before locking.${c.reset}`,
  );

  if (nonInteractive) {
    console.log(
      `${c.dim}Non-interactive: not writing. Add the block above to .kit.toml, or run ${c.reset}${c.bold}kit context check${c.reset}${c.dim} to lock it.${c.reset}\n`,
    );
    return;
  }

  const ok = await promptConfirm("Add this [context] lock to .kit.toml? [y/N] ", 10000, false);
  if (!ok) {
    console.log(
      `${c.dim}Skipped — run ${c.reset}${c.bold}kit context check${c.reset}${c.dim} later to add it.${c.reset}\n`,
    );
    return;
  }
  const existing = readFileSync(configPath, "utf-8");
  await writeFile(configPath, existing.trimEnd() + "\n\n" + block + "\n", "utf-8");
  console.log(
    `  ${c.green}✓${c.reset} Locked ${c.bold}[context]${c.reset} ${c.dim}→ verify with ${c.reset}${c.bold}kit context check${c.reset}\n`,
  );
}

// Network-posture setup step: connected (cloud scanners allowed) vs air-gapped
// enclave (cloud-only scanners dropped, internal mirrors). Writes [air_gap].
// Security: kit NEVER captures/echoes/stores scanner tokens here — connected mode
// only points at where they live (vault [scan.tooling] or env); kit reads them at
// scan time. Idempotent: if a posture is already declared, report it and return.
async function offerPosture(
  configPath: string,
  config: kitConfig,
  nonInteractive: boolean,
  forced: "connected" | "airgap" | null = null,
): Promise<void> {
  if (config.air_gap?.enabled !== undefined) {
    const mode = config.air_gap.enabled ? "air-gapped enclave" : "connected";
    console.log(
      `${c.dim}Network posture: ${c.reset}${c.bold}${mode}${c.reset} ${c.dim}(from .kit.toml [air_gap]).${c.reset}\n`,
    );
    return;
  }
  // A mode (airgap/local/ci/agent) forces the posture — write it without prompting.
  if (forced) {
    const { airGapTomlBlock } = await import("./airgap/config.js");
    const block = airGapTomlBlock(forced === "airgap");
    const existing = readFileSync(configPath, "utf-8");
    await writeFile(configPath, `${existing.trimEnd()}\n\n${block}\n`, "utf-8");
    console.log(
      `  ${c.green}✓${c.reset} posture ${c.bold}${forced}${c.reset} ${c.dim}→ wrote [air_gap] to .kit.toml${c.reset}\n`,
    );
    return;
  }
  if (nonInteractive) {
    console.log(
      `${c.dim}Network posture: connected (default). Set ${c.reset}${c.bold}[air_gap] enabled = true${c.reset}${c.dim} for an air-gapped enclave.${c.reset}\n`,
    );
    return;
  }

  const { airGapTomlBlock } = await import("./airgap/config.js");
  const choice = await promptSelect("Network posture for this project?", [
    {
      value: "connected",
      label: "Connected",
      hint: "cloud scanners (Snyk, Socket) available",
      recommended: true,
    },
    {
      value: "airgap",
      label: "Air-gapped enclave",
      hint: "no egress — cloud-only scanners dropped, offline DBs + internal mirrors",
    },
  ]);

  let block: string;
  if (choice === "airgap") {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ask = async (q: string) => (await rl.question(`  ${q} `)).trim();
      console.log(`${c.dim}Internal mirrors (Enter to skip each):${c.reset}`);
      block = airGapTomlBlock(true, {
        npmRegistry: await ask("npm registry URL:"),
        pypiIndex: await ask("PyPI index URL:"),
        githubApi: await ask("GitHub API base URL:"),
        dockerRegistry: await ask("Docker registry URL:"),
        threatDataDir: await ask("Signed threat-data dir (path):"),
      });
    } finally {
      rl.close();
    }
    console.log(
      `\n  ${c.yellow}⚠${c.reset} ${c.dim}Air-gapped: ${c.reset}${c.bold}kit scan${c.reset}${c.dim} drops cloud-only scanners (Snyk, Socket, semgrep) and runs trivy/grype/osv against local DBs. See docs/AIR_GAP.md.${c.reset}`,
    );
  } else {
    block = airGapTomlBlock(false);
    console.log(
      `\n  ${c.dim}Connected: cloud scanners are available. Provide their tokens via your vault ${c.reset}${c.bold}[scan.tooling]${c.reset}${c.dim} or env — kit reads them at scan time and ${c.reset}${c.bold}never stores them${c.reset}${c.dim}:${c.reset}`,
    );
    console.log(
      `    ${c.green}SNYK_TOKEN${c.reset}                 ${c.dim}→ kit scan runs Snyk${c.reset}`,
    );
    console.log(
      `    ${c.green}SOCKET_SECURITY_API_TOKEN${c.reset}  ${c.dim}→ kit scan runs Socket (socket ci)${c.reset}`,
    );
  }

  const existing = readFileSync(configPath, "utf-8");
  await writeFile(configPath, `${existing.trimEnd()}\n\n${block}\n`, "utf-8");
  console.log(
    `\n  ${c.green}✓${c.reset} Wrote ${c.bold}[air_gap]${c.reset} ${c.dim}(${choice === "airgap" ? "enabled" : "disabled"}) to .kit.toml${c.reset}\n`,
  );
}

/**
 * `kit statusline` — one compact, fast, read-only line for ANY harness's info bar
 * (Claude Code statusLine, a shell PS1, …): setup score for the active mode + an
 * "update available" mark + the open PAL count. Agent-agnostic; never blocks
 * (cached update only, file-presence subsystem checks). Assembly lives in
 * statusline.ts so the memory SessionStart hook injects the SAME line as context.
 */
async function cmdStatusline(): Promise<boolean> {
  process.env.KIT_NO_UPDATE_CHECK = "1"; // never let the post-command notice pollute the single line
  const { buildStatuslineText } = await import("./statusline.js");
  console.log(await buildStatuslineText({ modeFlag: flagValue(process.argv, "--mode") }));
  return true;
}

async function cmdInit(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit init${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const nonInteractive =
    hasFlag(process.argv, "--non-interactive") ||
    hasFlag(process.argv, "--yes") ||
    hasFlag(process.argv, "-y");

  const configPath = resolveConfigPath();

  // ── Auto-generate .kit.toml if absent ──────────────────────────────────
  let configMissing = false;
  try {
    await access(configPath);
  } catch {
    configMissing = true;
  }

  if (configMissing) {
    const result = await generateConfigFile(configPath, nonInteractive);
    if (result === "abort-error") return false; // can't generate (low confidence + non-interactive)
    if (result === "abort-user") return true; // user declined — exit 0, not an error
  }

  const config = await loadConfig(configPath);

  // Brownfield: offer to lock the already-active cloud/repo context (no install,
  // no login — just pin account+project) when none is declared yet.
  if (!config.context) {
    await offerContextLock(configPath, nonInteractive);
  }

  // Check if lock files exist
  const kitMeta = await readkitMeta();
  const skillsLock = await readSkillsLock();
  const cliLock = await readCliLock();

  if (kitMeta) {
    console.log(`${c.dim}kit: ${kitMeta.name}@${kitMeta.version}${c.reset}\n`);
  }

  if (!skillsLock && !cliLock) {
    console.log(`${c.yellow}No lock files found.${c.reset}`);
    console.log(`${c.dim}Generating lock files from .kit.toml...${c.reset}\n`);

    // Generate lock files from config
    await runStep("generate lock files", async () => {
      const skills: Record<string, string> = {};
      if (config.skills?.required) {
        Object.assign(skills, config.skills.required);
      }
      if (config.skills?.optional) {
        Object.assign(skills, config.skills.optional);
      }

      await updateSkillsLock(
        skills,
        kitMeta?.name ? `${kitMeta.name}@${kitMeta.version}` : undefined,
      );

      const tools: Record<
        string,
        { version: string; source: "mise" | "npm" | "pip" | "manual"; auth?: string }
      > = {};
      if (config.tools) {
        for (const [name, version] of Object.entries(config.tools)) {
          tools[name] = { version, source: "mise" };
        }
      }

      await updateCliLock(tools);
    });
    console.log();
  }

  // --no-setup: stop after .kit.toml + lock files; skip install / login / secrets.
  // (Mirrors `kit clone --no-setup`; previously `kit init` silently ignored this flag
  // and ran full setup anyway.)
  if (hasFlag(process.argv, "--no-setup")) {
    console.log(
      `${c.yellow}Setup skipped (--no-setup): .kit.toml + lock files generated; install / login / secrets not run.${c.reset}`,
    );
    return true;
  }

  // Now run the setup process
  const setupOk = await cmdSetup();

  // First-install hook: offer a global prescan against an operator-chosen
  // root (typically ~/projects). Asked once, marker written to
  // ~/.kit/first-install-prompted so re-runs of `kit init` (per
  // additional repos) don't re-ask. Honors --non-interactive/--yes/-y.
  if (setupOk && !nonInteractive) {
    await offerFirstInstallPrescan();
  }
  return setupOk;
}

async function offerFirstInstallPrescan(): Promise<void> {
  const homedir = (await import("node:os")).homedir();
  const markerDir = join(homedir, ".kit");
  const markerPath = join(markerDir, "first-install-prompted");
  try {
    await access(markerPath);
    return; // Already prompted on this machine.
  } catch {
    // Marker absent — proceed with prompt.
  }
  if (!process.stdin.isTTY) return;

  console.log();
  console.log(`${c.bold}${c.cyan}First-install: multi-repo prescan${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);
  console.log(`${c.dim}kit can scan every git repo under a directory for leaked secrets,`);
  console.log(
    `${c.dim}.gitignore holes, public-repo + credential combos, and CVE-deps.${c.reset}\n`,
  );

  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer = "";
  let scanPath = "";
  try {
    answer = (await rl.question(`Run a prescan now? [y/N] `)).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      const defaultPath = join(homedir, "projects");
      scanPath = (await rl.question(`Path to scan [${defaultPath}]: `)).trim() || defaultPath;
    }
  } finally {
    rl.close();
  }

  // Always write marker (even if user declined) — don't re-pester.
  await mkdir(markerDir, { recursive: true, mode: 0o700 });
  await writeFile(markerPath, new Date().toISOString() + "\n", { encoding: "utf-8", mode: 0o600 });

  if (answer !== "y" && answer !== "yes") {
    console.log(
      `${c.dim}Skipped. Run later with ${c.bold}kit security prescan <path>${c.reset}${c.dim}.${c.reset}\n`,
    );
    return;
  }

  console.log(`${c.dim}Running prescan against ${scanPath}…${c.reset}\n`);
  const { runPrescan } = await import("./security-prescan.js");
  const report = await runPrescan({ root: resolve(scanPath), deep: false });
  const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of report.findings) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  console.log(
    `${c.bold}Scanned${c.reset} ${report.repoCount} repo(s), ${report.findings.length} finding(s):`,
  );
  if (bySev.critical) console.log(`  ${c.red}critical${c.reset}: ${bySev.critical}`);
  if (bySev.high) console.log(`  ${c.red}high    ${c.reset}: ${bySev.high}`);
  if (bySev.medium) console.log(`  ${c.yellow}medium  ${c.reset}: ${bySev.medium}`);
  if (bySev.low) console.log(`  ${c.dim}low     ${c.reset}: ${bySev.low}`);
  if (report.summaryPath) {
    console.log(`\n${c.dim}Full report:${c.reset} ${report.summaryPath}`);
  }
  console.log();
}

async function cmdDoctor(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit doctor${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  let config: ReturnType<typeof Object.create> = {};
  try {
    config = await loadConfig(resolveConfigPath());
  } catch {
    // Doctor works even without .kit.toml — skip config-dependent checks
  }

  const result = await runDoctor(config, process.cwd());

  for (const check of result.checks) {
    const icon =
      check.status === "pass"
        ? `${c.green}✓${c.reset}`
        : check.status === "warn"
          ? `${c.yellow}⚠${c.reset}`
          : check.status === "fail"
            ? `${c.red}✗${c.reset}`
            : `${c.dim}–${c.reset}`;
    console.log(`  ${icon} ${check.name}  ${c.dim}${check.detail}${c.reset}`);
  }

  console.log();
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);

  const summaryParts: string[] = [];
  if (result.passed > 0) summaryParts.push(`${c.green}${result.passed} passed${c.reset}`);
  if (result.warnings > 0)
    summaryParts.push(
      `${c.yellow}${result.warnings} warning${result.warnings === 1 ? "" : "s"}${c.reset}`,
    );
  if (result.failed > 0) summaryParts.push(`${c.red}${result.failed} failed${c.reset}`);
  if (summaryParts.length === 0) summaryParts.push(`${c.dim}no checks ran${c.reset}`);

  console.log(`\n  ${summaryParts.join(" · ")}\n`);

  return result.failed === 0;
}

async function cmdAdd(): Promise<boolean> {
  const serviceName = process.argv[3];

  if (!serviceName) {
    console.log(`${c.bold}${c.cyan}Available services:${c.reset}\n`);

    const services = listAvailableServices();
    for (const svc of services) {
      const info = getServiceInfo(svc);
      if (info) {
        console.log(`  ${c.green}${svc}${c.reset}  ${c.dim}${info.description}${c.reset}`);
        console.log(`    ${c.dim}Requires: ${info.tools.join(", ")}${c.reset}`);
      }
    }

    console.log();
    console.log(`${c.dim}Usage: kit add <service>${c.reset}`);
    console.log(`${c.dim}Example: kit add stripe/payments${c.reset}`);
    console.log();
    return false;
  }

  console.log(`${c.bold}${c.cyan}Provisioning ${serviceName}...${c.reset}\n`);

  const projectPath = process.cwd();
  const projectName = process.cwd().split("/").pop();

  const result = await provisionService(serviceName, projectPath, projectName);

  if (result.success) {
    console.log(`  ${c.green}✓${c.reset} ${result.message}`);

    if (result.secrets && Object.keys(result.secrets).length > 0) {
      console.log();
      console.log(`  ${c.dim}Added secrets to .env.local:${c.reset}`);
      for (const key of Object.keys(result.secrets)) {
        console.log(`    ${c.cyan}${key}${c.reset}`);
      }
    }

    if (result.config) {
      console.log();
      console.log(`  ${c.dim}Updated skills-lock.json${c.reset}`);
    }

    console.log();
    return true;
  } else {
    console.log(`  ${c.red}✗${c.reset} ${result.message}`);
    if (result.error) {
      console.log(`  ${c.dim}Error: ${result.error}${c.reset}`);
    }
    console.log();
    return false;
  }
}

type CiFormat = "github" | "gitlab" | "json" | "text";

function detectCiFormat(): CiFormat {
  if (process.env.GITHUB_ACTIONS === "true") return "github";
  if (process.env.GITLAB_CI === "true") return "gitlab";
  if (process.env.CI === "true") return "text";
  return "text";
}

function emitGithubAnnotations(checks: JsonCheck[]): void {
  for (const ch of checks) {
    // Carry the offending file:line into the annotation when the finding has one.
    const where = ch.files && ch.files.length > 0 ? ` [${ch.files[0]}]` : "";
    const msg = escapeWorkflowCmd(`${ch.category}/${ch.name}: ${ch.detail}${where}`);
    if (ch.status === "fail") {
      console.log(`::error::${msg}`);
    } else if (ch.status === "warn") {
      console.log(`::warning::${msg}`);
    }
  }
}

function emitGitlabJunit(checks: JsonCheck[], allOk: boolean): void {
  const failures = checks.filter((c) => c.status === "fail");
  const warnings = checks.filter((c) => c.status === "warn");
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites name="kit-ci" tests="${checks.length}" failures="${failures.length}" errors="0">`,
    `  <testsuite name="kit" tests="${checks.length}" failures="${failures.length}">`,
  ];
  for (const ch of checks) {
    lines.push(`    <testcase name="${xmlEscape(ch.name)}" classname="${xmlEscape(ch.category)}">`);
    if (ch.status === "fail") {
      lines.push(`      <failure message="${xmlEscape(ch.detail)}"/>`);
    } else if (ch.status === "warn") {
      lines.push(`      <system-out>${xmlEscape(ch.detail)}</system-out>`);
    }
    lines.push(`    </testcase>`);
  }
  lines.push(`  </testsuite>`, `</testsuites>`);
  const xml = lines.join("\n");
  // Write to file for GitLab artifact collection — synchronous so the report is
  // guaranteed flushed before this (sync) function returns.
  writeFileSync("kit-report.xml", xml, "utf8");
  if (!allOk || warnings.length > 0) {
    console.log(
      `CI report written to kit-report.xml (${failures.length} failures, ${warnings.length} warnings)`,
    );
  }
}

async function cmdCi(): Promise<boolean> {
  const args = process.argv.slice(2);

  // `kit ci --init <gitlab|bitbucket>` — emit the pipeline snippet that runs
  // `kit ci` on a non-GitHub host. Prints to stdout (copy-paste); `--write`
  // writes the file only when absent (never clobbers an existing pipeline).
  const initIdx = args.indexOf("--init");
  if (initIdx !== -1) {
    const { pipelineSnippet, isCiHost, CI_HOSTS } = await import("./ci-init.js");
    const host = args[initIdx + 1] ?? "";
    if (!isCiHost(host)) {
      console.error(`kit ci --init: host must be one of ${CI_HOSTS.join(", ")}`);
      return false;
    }
    const { file, content } = pipelineSnippet(host);
    if (hasFlag(args, "--write")) {
      const path = resolve(process.cwd(), file);
      if (existsSync(path)) {
        console.error(`${file} already exists — not overwriting. Snippet to merge in:\n`);
        console.log(content);
        return false;
      }
      writeFileSync(path, content, "utf8");
      console.log(`${c.green}✓${c.reset} wrote ${file}`);
      return true;
    }
    console.log(content);
    return true;
  }

  const formatArg = args.find((a) => a.startsWith("--format="))?.split("=")[1] as
    | CiFormat
    | undefined;
  // Scanner-health STRICT BY DEFAULT (kit's "no false green" floor): a check that
  // could not RUN (tool/token absent, crashed) is marked didNotRun and FAILS the
  // gate — a green means every check actually ran. `--lenient` / KIT_CI_LENIENT
  // downgrades those back to warnings (the pre-3.3 behavior). Finding-level warnings
  // (things a check RAN and flagged) stay warnings unless `--fail-on-warning`, or the
  // max-strict `--strict` / KIT_CI_STRICT which fails on ANY warning.
  const lenient = hasFlag(args, "--lenient") || envTruthy(process.env.KIT_CI_LENIENT);
  const strict = hasFlag(args, "--strict") || envTruthy(process.env.KIT_CI_STRICT);
  const failOnWarning = hasFlag(args, "--fail-on-warning") || strict;
  const jsonMode = hasFlag(args, "--json");
  const format: CiFormat = formatArg ?? (jsonMode ? "json" : detectCiFormat());

  const config = await loadConfig(resolveConfigPath());

  return await withGovernance(
    config,
    { operation: "check", operationType: "read", metadata: {} },
    async () => {
      const live = format === "text";
      if (live) stepHeader("CI checks");
      const step = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
        live ? runStep(label, fn) : fn();

      const toolResults = config.tools ? await step("tools", () => checkTools(config.tools!)) : [];
      const serviceResults = config.services
        ? await step("services", () => checkServices(config.services!))
        : [];
      const secretResults = config.secrets
        ? await step("secrets", () => checkSecrets(config.secrets!))
        : { templateExists: null, keys: [] };
      const skillResults = config.skills
        ? await step("skills", () => checkSkills(config.skills!))
        : [];
      await autoInstallScanners(config, live); // self-heal missing scanners before scanning
      const securityResults = await step("security scan", () => checkSecurity());
      const lockResults = await step("lock files", () => checkLockFiles(config));
      // Signed org policy (.kit-policy.toml) — opt-in (absent ⇒ present:false ⇒ no
      // items ⇒ no effect on the verdict). Folds the same evaluatePolicy() the
      // `kit policy check` command uses into the CI gate, so a tampered/revoked
      // signature, unmet min_kit_version, or (under --strict) a missing required
      // scanner fails CI like any other check.
      const policyReport = await step("policy", () => evaluatePolicy(process.cwd(), { strict }));
      const policyStatus = (s: "pass" | "warn" | "fail" | "n/a"): JsonCheck["status"] =>
        s === "n/a" ? "skip" : s;

      const checks: JsonCheck[] = [
        ...toolResults.map((t) => ({
          name: t.name,
          status: (t.ok ? "pass" : "fail") as JsonCheck["status"],
          detail: t.installed ? `installed ${t.installed}` : "not installed",
          category: "tools",
        })),
        ...serviceResults.map((s) => ({
          name: s.name,
          // Informational services (no CLI login) are a manual-setup warning,
          // not a CI failure.
          status: (s.authenticated
            ? "pass"
            : s.informational
              ? "warn"
              : "fail") as JsonCheck["status"],
          detail: s.informational
            ? s.output || "manual setup (no CLI login)"
            : (s.output ?? (s.authenticated ? "authenticated" : "not authenticated")),
          category: "services",
        })),
        ...secretResults.keys.map((s) => ({
          name: s.name,
          status: (s.unverified ? "warn" : s.available ? "pass" : "fail") as JsonCheck["status"],
          detail: s.detail ?? (s.available ? "available" : "missing"),
          category: "secrets",
        })),
        ...skillResults.map((s) => ({
          name: s.name,
          status: (s.installed ? "pass" : s.required ? "fail" : "warn") as JsonCheck["status"],
          detail: s.installed ? "installed" : "not installed",
          category: "skills",
        })),
        ...lockResults.map((l) => ({
          name: l.category === "skills-lock" ? "skills-lock.json" : "cli-lock.json",
          status: (l.inSync ? "pass" : l.exists ? "warn" : "fail") as JsonCheck["status"],
          detail: l.detail,
          category: "lock",
        })),
        ...securityResults.map((s) => ({
          name: s.name,
          // Scanner-health strict by default: a check that could not run fails the
          // gate unless --lenient. A finding-warn (the check ran + flagged) is untouched.
          status: gateStatus(s, { lenient, failOnWarning }) as JsonCheck["status"],
          detail:
            s.didNotRun && !lenient
              ? `${s.detail}  [did not run — strict default; --lenient to downgrade to warn]`
              : s.detail,
          category: `security/${s.category}`,
        })),
        ...(policyReport.present
          ? [
              ...(policyReport.signature
                ? [
                    {
                      name: "signature",
                      status: policyStatus(policyReport.signature.status),
                      detail: policyReport.signature.detail,
                      category: "policy",
                    },
                  ]
                : []),
              ...policyReport.items.map((i) => ({
                name: i.requirement,
                status: policyStatus(i.status),
                detail: i.detail,
                category: "policy",
              })),
            ]
          : []),
      ];

      const summary = checks.reduce(
        (acc, c) => {
          if (c.status === "pass") acc.passed++;
          else if (c.status === "fail") acc.failed++;
          else if (c.status === "warn") acc.warnings++;
          else acc.skipped++;
          return acc;
        },
        { passed: 0, failed: 0, warnings: 0, skipped: 0 },
      );

      const allOk = summary.failed === 0 && (!failOnWarning || summary.warnings === 0);

      if (format === "github") {
        if (process.env.GITHUB_STEP_SUMMARY) {
          // Emit markdown summary to GitHub Actions step summary. Strip CR/LF so a
          // crafted detail can't inject new markdown/table rows, and escape `|` so
          // it can't forge extra table cells.
          const mdCell = (s: string) =>
            String(s)
              .replace(/[\r\n]+/g, " ")
              .replace(/\|/g, "\\|");
          const lines = [
            "## kit CI Report",
            `| Status | Check | Detail |`,
            `|--------|-------|--------|`,
            ...checks.map(
              (c) =>
                `| ${c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️" : "❌"} | \`${mdCell(`${c.category}/${c.name}`)}\` | ${mdCell(c.detail)} |`,
            ),
            ``,
            `**${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings**`,
          ];
          await import("node:fs/promises").then(({ appendFile }) =>
            appendFile(process.env.GITHUB_STEP_SUMMARY!, lines.join("\n") + "\n"),
          );
        }
        emitGithubAnnotations(checks);
        console.log(
          `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`,
        );
      } else if (format === "gitlab") {
        emitGitlabJunit(checks, allOk);
        console.log(
          `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`,
        );
      } else if (format === "json") {
        const output: JsonCheckOutput = { ok: allOk, checks, summary };
        console.log(JSON.stringify(output, null, 2));
      } else {
        // text
        const failures = checks.filter((c) => c.status === "fail");
        const warnings = checks.filter((c) => c.status === "warn");
        if (failures.length > 0) {
          console.log(`FAILURES:`);
          failures.forEach((f) => console.log(`  ✗ [${f.category}] ${f.name}: ${f.detail}`));
        }
        if (warnings.length > 0) {
          console.log(`WARNINGS:`);
          warnings.forEach((w) => console.log(`  ! [${w.category}] ${w.name}: ${w.detail}`));
        }
        console.log(
          `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`,
        );
      }

      // Opt-in signed attestation receipt. scanners_ran reflects the security
      // gates (which ran vs were skipped/errored). Quiet in json/non-text so it
      // never corrupts machine-readable output.
      await maybeEmitCheckAttestation(
        "ci",
        allOk,
        summary,
        securityResults.map((s) => ({ id: s.name, status: s.status })),
        format !== "text",
      );

      return allOk;
    },
  );
}

async function cmdVerifyAttestation(): Promise<boolean> {
  // kit check verify-attestation [file] [--key <spki|fingerprint>] [--pin]
  const args = process.argv.slice(4);
  const file = args.find((a) => !a.startsWith("-")) ?? ".kit-check-attestation.json";
  const expectedKey = flagValue(args, "--key");
  const doPin = hasFlag(args, "--pin");
  const { readFile } = await import("node:fs/promises");
  const { verifyAttestation, pinEd25519Fingerprint, ATTESTATION_FILE } =
    await import("./check-attestation.js");
  const path = resolve(process.cwd(), file);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    console.error(
      `${c.red}✗ no attestation at ${file}${c.reset}  ${c.dim}(default: ${ATTESTATION_FILE})${c.reset}`,
    );
    return false;
  }
  let att;
  try {
    att = JSON.parse(raw);
  } catch {
    console.error(`${c.red}✗ attestation is not valid JSON: ${file}${c.reset}`);
    return false;
  }
  const r = await verifyAttestation(att, { expectedKey });
  const fpNote = r.fingerprint
    ? `  ${c.dim}ed25519 key sha256:${r.fingerprint.slice(0, 16)}…${c.reset}`
    : "";

  if (r.status === "ok") {
    console.log(
      `${c.green}✓ attestation verified${c.reset}  ${c.dim}${r.sig_alg}: ${att.command} on kit ${att.kit_version}, overall_ok=${att.overall_ok}${c.reset}${fpNote}`,
    );
    if (r.sig_alg === "hmac-sha256") {
      console.log(
        `${c.dim}HMAC verified against the machine-local anchor key (a valid MAC binds the receipt to a key-holder). Does NOT prove the host was untampered - a same-UID key reader can forge.${c.reset}`,
      );
    } else {
      console.log(
        `${c.dim}Ed25519 signature matches the pinned/expected key. Does NOT prove the host was untampered - a same-UID key reader can forge.${c.reset}`,
      );
    }
    return true;
  }

  if (r.status === "unverified-authenticity") {
    // Honest, non-green outcome: valid math, unauthenticated signer.
    if (doPin && r.fingerprint) {
      try {
        await pinEd25519Fingerprint(r.fingerprint);
        console.warn(
          `${c.yellow}! pinned Ed25519 key sha256:${r.fingerprint.slice(0, 16)}… as trusted (TOFU).${c.reset} ${c.dim}Re-run verify to authenticate against the pin. NOTE: pinning a forged receipt's key trusts the forger - only pin a key you know is genuine.${c.reset}`,
        );
        return false; // still not authenticated on THIS run
      } catch (err) {
        console.error(`${c.red}✗ could not pin key: ${(err as Error).message}${c.reset}`);
        return false;
      }
    }
    console.error(
      `${c.yellow}! attestation UNVERIFIED-AUTHENTICITY${c.reset} ${c.dim}(${r.sig_alg})${c.reset}${fpNote}`,
    );
    console.error(`${c.dim}${r.reason}${c.reset}`);
    return false;
  }

  console.error(`${c.red}✗ attestation FAILED: ${r.reason}${c.reset}${fpNote}`);
  return false;
}

async function cmdSelfAudit(): Promise<boolean> {
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
async function cmdCoverage(): Promise<boolean> {
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
    const { runGhaAudit } = await import("./gha-audit.js");
    const { runCiAudit } = await import("./ci-audit.js");
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

  // --standard selects which pinned standard to map against (default ASVS, the
  // original path). llm-top10 / ssdf route through the generic evidence-map engine.
  const standard = args.find((a) => a.startsWith("--standard="))?.split("=")[1] ?? "asvs";
  const STANDARDS = { "llm-top10": OWASP_LLM_TOP10, ssdf: SSDF_218A } as const;
  if (standard !== "asvs") {
    const descriptor = STANDARDS[standard as keyof typeof STANDARDS];
    if (!descriptor) {
      console.error(
        `${c.red}unknown --standard '${standard}' (use: asvs | llm-top10 | ssdf)${c.reset}`,
      );
      process.exitCode = 1;
      return false;
    }
    const stdReport = buildStandardReport(descriptor, results);
    console.log(
      jsonMode ? JSON.stringify(stdReport, null, 2) : formatStandardText(stdReport, colorBucket),
    );
    return true;
  }

  const report = buildCoverageReport(results);
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return true;
  }
  console.log(formatCoverageText(report, colorBucket));
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
  };
  const byClass = new Map<string, number>();
  for (const a of advisories) byClass.set(a.category, (byClass.get(a.category) ?? 0) + 1);
  return [...byClass.entries()].map(([cls, count]) => ({
    cls,
    count,
    label: ADVISORY_LABELS[cls] ?? "advisory findings",
  }));
}

async function cmdAnalyze(): Promise<boolean> {
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

async function cmdCreatePlugin(): Promise<boolean> {
  const pluginName = process.argv[3];

  if (!pluginName) {
    console.error(`${c.red}Usage: kit create-plugin <name>${c.reset}`);
    console.error(`${c.dim}Example: kit create-plugin aws-s3${c.reset}`);
    console.error(
      `${c.dim}Creates ./kit-plugin-aws-s3/ with a working TypeScript adapter.${c.reset}`,
    );
    return false;
  }

  const skipInstall = hasFlag(process.argv, "--skip-install");

  console.log(`${c.bold}${c.cyan}Scaffolding kit plugin...${c.reset}\n`);

  const result = await createPlugin({
    name: pluginName,
    cwd: process.cwd(),
    skipInstall,
  });

  if (result.success) {
    console.log(`  ${c.green}✓${c.reset} ${result.message}`);
    console.log();
    console.log(`${c.bold}Next steps:${c.reset}`);
    for (const step of result.nextSteps) {
      console.log(`  ${c.dim}${step}${c.reset}`);
    }
    console.log();
    console.log(`${c.dim}See PLUGIN_AUTHORING.md for full documentation.${c.reset}`);
    return true;
  }

  return false;
}

async function cmdClone(): Promise<boolean> {
  const args = process.argv.slice(2);
  const repoUrl = args[1];
  const targetDir = args[2];
  const noSetup = hasFlag(args, "--no-setup");
  const environment = hasFlag(args, "--env") ? args[args.indexOf("--env") + 1] : "default";

  if (!repoUrl) {
    console.error(`${c.red}Usage: kit clone <repo-url> [directory]${c.reset}`);
    console.error();
    console.error(`${c.dim}Options:${c.reset}`);
    console.error(`${c.dim}  --no-setup           Skip running kit setup after cloning${c.reset}`);
    console.error(
      `${c.dim}  --env <name>         Environment to use for setup (default: "default")${c.reset}`,
    );
    console.error();
    console.error(`${c.dim}Example:${c.reset}`);
    console.error(`${c.dim}  kit clone https://github.com/sandstream/example my-project${c.reset}`);
    console.error(
      `${c.dim}  kit clone https://github.com/sandstream/example my-project --env production${c.reset}`,
    );
    console.error(
      `${c.dim}  kit clone https://github.com/sandstream/example my-project --no-setup${c.reset}`,
    );
    return false;
  }

  console.log(`${c.bold}${c.cyan}kit clone${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const cloneResult = await cloneRepository({
    repoUrl,
    targetDir,
    noSetup,
    environment,
    cwd: process.cwd(),
  });

  if (!cloneResult.success) {
    console.error(`${c.red}✗ Clone failed: ${cloneResult.message}${c.reset}`);
    return false;
  }

  console.log(`${c.green}✓ Repository cloned to ${cloneResult.clonedPath}${c.reset}`);
  console.log();

  if (!cloneResult.haskitToml) {
    console.log(`${c.yellow}⚠ No .kit.toml found in repository.${c.reset}`);
    console.log(
      `${c.dim}Create one with 'cd ${cloneResult.clonedPath} && kit init' to set up kit.${c.reset}`,
    );
    console.log();
    return true;
  }

  if (cloneResult.setupSkipped) {
    console.log(`${c.yellow}Setup skipped (--no-setup flag set).${c.reset}`);
    console.log(`${c.dim}Run: cd ${cloneResult.clonedPath} && kit setup${c.reset}`);
    console.log();
    return true;
  }

  // Run setup in the cloned directory
  console.log(`${c.bold}Running setup in cloned repository...${c.reset}\n`);

  const originalCwd = process.cwd();
  try {
    process.chdir(cloneResult.clonedPath);
    const setupOk = await cmdSetup();
    process.chdir(originalCwd);

    if (!setupOk) {
      console.log(`${c.yellow}Clone completed but setup failed. See above for details.${c.reset}`);
    }
    return setupOk;
  } catch (err) {
    process.chdir(originalCwd);
    console.error(
      `${c.red}Error during setup: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    return false;
  }
}

async function cmdRun(): Promise<boolean> {
  const args = process.argv.slice(2);

  // Find the -- separator
  const doubleDashIndex = args.indexOf("--");
  if (doubleDashIndex === -1 || doubleDashIndex === args.length - 1) {
    console.error(`${c.red}Usage: kit run -- <command> [args...]${c.reset}`);
    console.error();
    console.error(`${c.dim}Options:${c.reset}`);
    console.error(
      `${c.dim}  --env <name>    Environment to use (dev, staging, production, etc.)${c.reset}`,
    );
    console.error();
    console.error(`${c.dim}Example:${c.reset}`);
    console.error(`${c.dim}  kit run -- pnpm test${c.reset}`);
    console.error(`${c.dim}  kit run --env staging -- node scripts/migrate.js${c.reset}`);
    return false;
  }

  // Extract environment name if provided (reserved for future use)
  const envIndex = args.indexOf("--env");
  if (envIndex !== -1 && envIndex < doubleDashIndex) {
    // Environment flag parsed but not currently used in env var logic
    // Can be extended in future to select environment-specific config
  }

  // Extract command and args after --
  const commandArgs = args.slice(doubleDashIndex + 1);

  const result = await executeCommand({
    commandArgs,
    cwd: process.cwd(),
    inheritEnv: true,
  });

  process.exitCode = result.exitCode;
  return result.exitCode === 0;
}

async function cmdOpen(): Promise<boolean> {
  const args = process.argv.slice(2);
  const serviceName = args[1];

  // Load env from .env.local for dashboard URL resolution
  const env: Record<string, string> = {};
  try {
    const envPath = resolve(process.cwd(), ".env.local");
    const { readFileSync } = await import("node:fs");
    const envContent = readFileSync(envPath, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.substring(0, eqIndex);
      const value = trimmed.substring(eqIndex + 1);
      env[key] = value;
    }
  } catch {
    // .env.local not found — continue with empty env
  }

  if (!serviceName || serviceName.startsWith("-")) {
    // No service specified — show menu
    console.log(`${c.bold}kit open${c.reset} — open service dashboards\n`);
    console.log(`${c.bold}Usage:${c.reset}`);
    console.log(`  kit open <service>${c.dim} — open service dashboard${c.reset}`);
    console.log();

    const services = listServices();
    const maxLen = Math.max(...services.map((s) => s.name.length));

    console.log(`${c.bold}Available services:${c.reset}`);
    for (const service of services) {
      const pad = " ".repeat(maxLen - service.name.length + 2);
      console.log(`  ${c.green}${service.name}${c.reset}${pad}${c.dim}${service.label}${c.reset}`);
    }
    console.log();
    console.log(`${c.dim}Example: kit open stripe${c.reset}`);
    return true;
  }

  const result = await openService(serviceName, env);

  if (result.success) {
    console.log(`${c.green}✓${c.reset} ${result.message}`);
    return true;
  } else {
    console.error(`${c.red}✗${c.reset} ${result.message}`);
    return false;
  }
}

async function cmdStatus(): Promise<boolean> {
  const items = await gatherStatus();
  if (hasFlag(process.argv, "--json")) {
    console.log(JSON.stringify(items, null, 2));
    return true;
  }
  const done = items.filter((i) => i.ok).length;
  console.log(`${c.bold}kit status${c.reset}  ${c.dim}${done}/${items.length} set up${c.reset}`);
  // Mode-aware score: how many of the active mode's expected subsystems are in place.
  let cfgMode: string | undefined;
  try {
    cfgMode = (await loadConfig(resolveConfigPath())).setup?.mode;
  } catch {
    /* no/invalid .kit.toml */
  }
  const { profile } = resolveMode(flagValue(process.argv, "--mode"), cfgMode);
  const ms = modeScore(profile, quickSubsystems(process.cwd()));
  const nextGaps = ms.gaps
    .map((g) => g.next)
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
  console.log(
    `${c.dim}mode ${c.reset}${c.bold}${profile.mode}${c.reset}${c.dim}: ${ms.done}/${ms.total} subsystems${ms.gaps.length ? ` — next: ${nextGaps}` : " ✓"}${c.reset}\n`,
  );
  for (const item of items) {
    const mark = item.ok ? `${c.green}✓${c.reset}` : `${c.yellow}○${c.reset}`;
    const hint = !item.ok && item.hint ? `  ${c.dim}→ ${item.hint}${c.reset}` : "";
    console.log(`  ${mark} ${item.label}  ${c.dim}${item.detail}${c.reset}${hint}`);
  }
  return true;
}

/** Build the health context (sensor selection inputs) — shared by health + sentinel. */
async function buildHealthCtx(config: kitConfig): Promise<HealthCtx> {
  const { execFileNoThrow } = await import("./utils/execFileNoThrow.js");
  const remote = await execFileNoThrow("git", ["remote"], { timeout: 5_000 });
  const cwd = process.cwd();
  let vercel: { orgId?: string; projectId?: string } | undefined;
  try {
    const vj = JSON.parse(readFileSync(resolve(cwd, ".vercel", "project.json"), "utf8")) as {
      orgId?: string;
      projectId?: string;
    };
    if (vj.projectId) vercel = { orgId: vj.orgId, projectId: vj.projectId };
  } catch {
    vercel = undefined;
  }
  let services: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const { detectServices } = await import("./service-registry.js");
    services = await detectServices({ deps, fileExists: async (p) => existsSync(resolve(cwd, p)) });
  } catch {
    services = [];
  }
  return {
    cwd,
    config,
    gitRemote: remote.ok && remote.stdout.trim().length > 0,
    gitlabCi: existsSync(resolve(cwd, ".gitlab-ci.yml")),
    bitbucketPipelines: existsSync(resolve(cwd, "bitbucket-pipelines.yml")),
    vercel,
    services,
  };
}

async function cmdHealth(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const config = await loadConfig(resolveConfigPath());

  return await withGovernance(
    config,
    { operation: "health", operationType: "read", metadata: {} },
    async () => {
      const { runHealth, selectSensors, defaultHealthDeps, formatHealth } =
        await import("./health.js");
      const { syncHealthFindings } = await import("./health-track.js");

      const ctx = await buildHealthCtx(config);

      const sensors = selectSensors(ctx);
      const findings = await runHealth(ctx, sensors, defaultHealthDeps);
      await syncHealthFindings(findings); // mirror red into PAL (fail-open)

      if (jsonMode) {
        const redCount = findings.filter((f) => f.status === "red").length;
        console.log(JSON.stringify({ ok: redCount === 0, findings }, null, 2));
        return redCount === 0;
      }

      const { lines, redCount } = formatHealth(findings);
      console.log(`${c.bold}kit health${c.reset}  ${c.dim}${sensors.length} sensor(s)${c.reset}`);
      if (findings.length === 0) {
        console.log(`  ${c.dim}no connected external systems detected${c.reset}`);
      }
      for (const line of lines) {
        const color = line.startsWith("✗") ? c.red : line.startsWith("?") ? c.yellow : c.green;
        console.log(`  ${color}${line}${c.reset}`);
      }
      if (redCount > 0) console.log(`${c.red}${redCount} red${c.reset}`);
      return redCount === 0;
    },
  );
}

async function cmdIngest(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const args = process.argv.slice(3).filter((a) => !a.startsWith("-"));
  const format = args[0];
  const file = args[1];
  if (format !== "sarif" && format !== "osv") {
    console.error(`${c.red}usage: kit ingest <sarif|osv> <file>${c.reset}`);
    process.exitCode = 1;
    return false;
  }
  if (!file) {
    console.error(`${c.red}usage: kit ingest ${format} <file>${c.reset}`);
    process.exitCode = 1;
    return false;
  }
  let json: string;
  try {
    json = readFileSync(resolve(process.cwd(), file), "utf8");
  } catch {
    console.error(`${c.red}could not read ${file}${c.reset}`);
    process.exitCode = 1;
    return false;
  }

  const { ingest } = await import("./adapters/ingest.js");
  const findings = ingest(format, json);

  if (jsonMode) {
    console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
    return true;
  }

  console.log(
    `${c.bold}kit ingest${c.reset}  ${c.dim}${format} · ${findings.length} finding(s)${c.reset}`,
  );
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...findings].sort(
    (a, b) => (order[a.severity ?? "low"] ?? 9) - (order[b.severity ?? "low"] ?? 9),
  );
  for (const f of sorted) {
    const sev = f.severity ?? "low";
    const color =
      sev === "critical" || sev === "high" ? c.red : sev === "medium" ? c.yellow : c.dim;
    const cite = f.rule ? ` ${c.dim}[${f.rule.id}]${c.reset}` : "";
    console.log(`  ${color}${sev.toUpperCase().padEnd(8)}${c.reset} ${f.name}${cite}`);
    console.log(`    ${c.dim}${f.detail}${c.reset}`);
  }
  return true;
}

async function cmdSupplyChain(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  // Config-free: supply-chain triage is project-agnostic (it reads the lockfile,
  // not .kit.toml), so a missing config is not an error — mirror `kit scan`.
  const config = existsSync(resolveConfigPath())
    ? await loadConfig(resolveConfigPath())
    : ({} as kitConfig);
  const scopes = config.supply_chain?.internal_scopes ?? [];
  const { runSupplyChain } = await import("./supply-chain.js");
  const results = runSupplyChain(process.cwd(), scopes);
  const fails = results.filter((r) => r.status === "fail").length;

  if (jsonMode) {
    console.log(JSON.stringify({ ok: fails === 0, results }, null, 2));
    return fails === 0;
  }

  console.log(`${c.bold}kit supply-chain${c.reset}`);
  for (const r of results) {
    const mark =
      r.status === "fail"
        ? `${c.red}✗${c.reset}`
        : r.status === "warn"
          ? `${c.yellow}!${c.reset}`
          : r.status === "skip"
            ? `${c.dim}−${c.reset}`
            : `${c.green}✓${c.reset}`;
    console.log(`  ${mark} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
    if (r.suggestion) console.log(`      ${c.dim}${r.suggestion}${c.reset}`);
  }
  if (fails > 0) console.log(`${c.red}${fails} fail${c.reset}`);
  return fails === 0;
}

async function cmdAgentAudit(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const { runAgentAudit } = await import("./agent-audit.js");
  const results = runAgentAudit(process.cwd());
  const fails = results.filter((r) => r.status === "fail").length;

  if (jsonMode) {
    console.log(JSON.stringify({ ok: fails === 0, results }, null, 2));
    return fails === 0;
  }

  console.log(
    `${c.bold}kit agent-audit${c.reset}  ${c.dim}agent/MCP configs + git hooks${c.reset}`,
  );
  for (const r of results) {
    const mark =
      r.status === "fail"
        ? `${c.red}✗${c.reset}`
        : r.status === "warn"
          ? `${c.yellow}!${c.reset}`
          : `${c.green}✓${c.reset}`;
    console.log(`  ${mark} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
    if (r.suggestion) console.log(`      ${c.dim}${r.suggestion}${c.reset}`);
  }
  if (fails > 0) console.log(`${c.red}${fails} fail${c.reset}`);
  return fails === 0;
}

async function cmdSentinel(): Promise<boolean> {
  const sub = process.argv[3];
  if (sub === "install") return cmdSentinelInstall();
  if (sub === "status") return cmdSentinelStatus();
  if (sub !== "run") {
    console.error(`${c.red}usage: kit sentinel <run|install|status> [--json]${c.reset}`);
    process.exitCode = 1;
    return false;
  }
  const jsonMode = hasFlag(process.argv, "--json");
  // Config-free: sentinel proposes fixes from codebase analysis; the optional
  // [sentinel] block only adds integrations. Missing .kit.toml is not an error.
  const config = existsSync(resolveConfigPath())
    ? await loadConfig(resolveConfigPath())
    : ({} as kitConfig);
  const { runSentinel, healthToRedFindings, proposalSummary, SENTINEL_CACHE } =
    await import("./sentinel.js");
  const { runHealth, selectSensors, defaultHealthDeps } = await import("./health.js");
  const { execFileNoThrow } = await import("./utils/execFileNoThrow.js");

  const proposals = await runSentinel(process.cwd(), {
    gatherRed: async () => {
      const ctx = await buildHealthCtx(config);
      return healthToRedFindings(await runHealth(ctx, selectSensors(ctx), defaultHealthDeps));
    },
    openMarkers: async () => {
      // Read-only dedup: open issues + PRs labeled kit-sentinel, scrape findingId markers.
      const out = new Set<string>();
      for (const base of [
        ["issue", "list"],
        ["pr", "list"],
      ]) {
        const res = await execFileNoThrow(
          "gh",
          [
            ...base,
            "--label",
            "kit-sentinel",
            "--state",
            "open",
            "--json",
            "body",
            "--limit",
            "200",
          ],
          { timeout: 15_000 },
        );
        if (!res.ok) return null; // gh absent/unauth → agent dedups (fail-open)
        try {
          for (const it of JSON.parse(res.stdout) as { body?: string }[]) {
            for (const g of (it.body ?? "").matchAll(/kit-sentinel:([^\s]+?)\s*-->/g))
              out.add(g[1]);
          }
        } catch {
          return null;
        }
      }
      return out;
    },
  });

  // L3: cache a compact summary for the SessionStart surface (#53). Best-effort —
  // a cache-write failure must never fail the run itself.
  try {
    const cachePath = resolve(process.cwd(), SENTINEL_CACHE);
    await mkdir(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(proposalSummary(proposals), null, 2) + "\n");
  } catch {
    // no cache → status surface simply stays quiet
  }

  if (jsonMode) {
    console.log(JSON.stringify({ proposals }, null, 2));
    return true;
  }

  const fresh = proposals.filter((p) => p.alreadyOpen !== true);
  console.log(
    `${c.bold}kit sentinel${c.reset}  ${c.dim}${proposals.length} proposal(s), ${fresh.length} fresh${c.reset}`,
  );
  if (proposals.length === 0)
    console.log(`  ${c.dim}no red findings — nothing to propose${c.reset}`);
  for (const p of proposals) {
    const tag = p.alreadyOpen === true ? ` ${c.dim}(already open)${c.reset}` : "";
    const color = p.class === "human" ? c.red : p.class === "code" ? c.yellow : c.dim;
    console.log(`  ${color}${p.artifact}${c.reset} ${p.title}${tag}`);
    console.log(`    ${c.dim}${p.findingId} — your agent opens this with its own creds${c.reset}`);
  }
  if (proposals.length > 0)
    console.log(`${c.dim}run with --json and have any agent act on the fresh proposals${c.reset}`);
  return true;
}

/** `kit sentinel install` — scaffold the L3 scheduler (GitHub Actions) (#53). */
async function cmdSentinelInstall(): Promise<boolean> {
  const { sentinelWorkflow } = await import("./sentinel.js");
  const dest = resolve(process.cwd(), ".github/workflows/kit-sentinel.yml");
  if (existsSync(dest) && !hasFlag(process.argv, "--force")) {
    console.error(
      `${c.yellow}.github/workflows/kit-sentinel.yml exists — re-run with --force to overwrite${c.reset}`,
    );
    process.exitCode = 1;
    return false;
  }
  const si = process.argv.indexOf("--schedule");
  const schedule = si >= 0 ? process.argv[si + 1] : undefined;
  await mkdir(dirname(dest), { recursive: true });
  writeFileSync(dest, schedule ? sentinelWorkflow(schedule) : sentinelWorkflow());
  console.log(`${c.green}✓${c.reset} wrote .github/workflows/kit-sentinel.yml`);
  console.log(
    `  ${c.dim}recurs \`kit sentinel run --json\`; an agent (or a downstream step) acts on the JSON${c.reset}`,
  );
  return true;
}

/** `kit sentinel status` — print the cached one-line surface for a SessionStart hook (#53). */
async function cmdSentinelStatus(): Promise<boolean> {
  const { SENTINEL_CACHE, sentinelStatusLine } = await import("./sentinel.js");
  let summary: SentinelSummary | null = null;
  try {
    summary = JSON.parse(readFileSync(resolve(process.cwd(), SENTINEL_CACHE), "utf8"));
  } catch {
    // no cache yet (sentinel never run) → nothing to surface
  }
  if (hasFlag(process.argv, "--json")) {
    console.log(
      JSON.stringify(summary ?? { total: 0, fresh: 0, byClass: { code: 0, human: 0, noise: 0 } }),
    );
    return true;
  }
  const line = sentinelStatusLine(summary);
  if (line) console.log(line); // silent when nothing fresh → clean SessionStart surface
  return true;
}

async function cmdWhoami(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");

  let config: ReturnType<typeof Object.create> = {};
  try {
    config = await loadConfig(resolveConfigPath());
  } catch {
    // Works without .kit.toml
  }

  const { detectEnvironment } = await import("./environment.js");
  const envInfo = detectEnvironment(config.governance);

  const agent = config.governance?.agent;
  const budgetEnabled =
    config.governance?.enabled && (agent?.max_tokens_per_day || agent?.max_operations_per_hour);

  let budget: Awaited<ReturnType<typeof getBudgetStatus>> | null = null;
  if (budgetEnabled) {
    budget = await getBudgetStatus(config.governance);
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          agent: agent ? { id: agent.id, name: agent.name } : null,
          environment: envInfo.environment,
          environment_source: envInfo.source,
          budget: budget
            ? {
                tokens_used: budget.tokens_used,
                tokens_limit: budget.tokens_limit,
                operations_used: budget.operations_used,
                operations_limit: budget.operations_limit,
              }
            : null,
        },
        null,
        2,
      ),
    );
    return true;
  }

  console.log(`${c.bold}${c.cyan}kit whoami${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (agent?.id || agent?.name) {
    if (agent.name) console.log(`  ${c.bold}Agent:${c.reset}  ${agent.name}`);
    if (agent.id) console.log(`  ${c.bold}ID:${c.reset}     ${c.dim}${agent.id}${c.reset}`);
  } else {
    console.log(`  ${c.dim}No agent configured in [governance.agent]${c.reset}`);
  }

  const envColor =
    envInfo.environment === "prod" ? c.red : envInfo.environment === "staging" ? c.yellow : c.green;
  console.log(
    `  ${c.bold}Env:${c.reset}    ${envColor}${envInfo.environment}${c.reset}  ${c.dim}(via ${envInfo.source})${c.reset}`,
  );

  if (budget) {
    console.log();
    const tokensLine = budget.tokens_limit
      ? `${budget.tokens_used.toLocaleString()} / ${budget.tokens_limit.toLocaleString()} tokens today`
      : `${budget.tokens_used.toLocaleString()} tokens today`;
    const opsLine = budget.operations_limit
      ? `${budget.operations_used} / ${budget.operations_limit} operations this hour`
      : `${budget.operations_used} operations this hour`;
    console.log(`  ${c.bold}Budget:${c.reset} ${c.dim}${tokensLine}${c.reset}`);
    console.log(`          ${c.dim}${opsLine}${c.reset}`);
  }

  console.log();
  return true;
}

function cmdVersion(): boolean {
  console.log(KIT_VERSION);
  return true;
}

export const COMMAND_HELP: Record<string, string> = {
  status: "Adoption checklist — what's set up across kit + the next step for each gap",
  statusline:
    "Compact one-line status (mode score · update · open PAL) for any agent's info bar — wire into Claude Code statusLine / a shell PS1",
  check: "Check status of all tools, services, secrets, and lock files",
  "check verify-attestation": "Verify a signed .kit-check-attestation.json receipt",
  health: "Deep environment health diagnostics — granular pass/fail across tools, services, config",
  scan: "Run external scanners (snyk/trivy/grype/semgrep/osv) and merge them into one local verdict (--strict / [governance.scan] required_scanners gate non-running scanners)",
  airgap: "Air-gap posture tools (verify)",
  "airgap verify":
    "Prove zero-egress: assert every scanner that would run air-gapped resolves to a local artifact (no cloud-only, no registry semgrep config)",
  sentinel: "Autonomous redline watcher — propose/apply guarded remediations (run|install|status)",
  "supply-chain":
    "Install-time supply-chain triage: install-scripts, lockfile-drift, dep-confusion, slopsquat",
  "agent-audit": "Audit agent / MCP / hook configs for plaintext secrets + malware-shaped hooks",
  "gha-audit":
    "CI hardening lint — unpinned actions/images + pwn-request/remote-include (GitHub Actions, GitLab CI, Bitbucket Pipelines)",
  sbom: "Generate a CycloneDX / SPDX SBOM from the lockfile (SARIF emit via kit scan --sarif)",
  ingest:
    "Ingest external SARIF / OSV reports into kit's consolidated verdict (kit ingest <sarif|osv> <file>)",
  "verify-provenance":
    "Verify a release's SLSA provenance bundle offline (Ed25519 + SHA256 / cosign)",
  review: "Full repo audit — runs check + design + standards in one gate (for agents / PR checks)",
  "self-audit":
    "Audit kit's own source against its 12 self-hardening rules (--list-rules, --only=<ids>, --format)",
  coverage:
    "Evidence map: which standard's controls kit's deterministic checks auto-verify vs gap/manual/n-a — OWASP ASVS L2 (default), OWASP LLM Top 10, or NIST SSDF via --standard=asvs|llm-top10|ssdf (NOT a compliance attestation; --json for GRC tools)",
  identity:
    "Manage this machine/agent's Ed25519 identity (init/show/rotate) — asymmetric, attributable signing for audit/policy (experimental)",
  panic:
    "Compromise response: rotate identity + emit a signed revocation + audit it + print the platform-revocation checklist (experimental)",
  policy:
    "Signable org policy-as-code in .kit-policy.toml (init/show/validate/sign/verify/check/trust) — identity-signed standard, org-distributable + enforced offline (experimental)",
  design: "Check design quality (a11y, design tokens) against the baseline",
  standards:
    "Dev-standards gate: general metrics + per-language linters + user plugins vs the baseline (--category general|specific|plugins|<lang>, --enforce fails CI)",
  baseline:
    "Freeze current warnings into .kit-baseline.json so future runs gate only net-new findings",
  memory: "Local conversation memory — index transcripts + show stats",
  "memory index": "Index ~/.claude transcripts into the SQLite memory store",
  "memory search": "Full-text search memory (current project; --global for all)",
  "memory stats": "Show what the local memory store contains",
  "memory suggest":
    "Emit a BYO-LLM review prompt (recent activity + open items) — pipe to your own model",
  "memory merge": "Merge another machine's memory.db into this one (dedup by uuid)",
  "memory sync":
    "Sync from a memory export or encrypted backup (mergeDb; last-write-wins, file_index excluded)",
  "memory install":
    "Wire UserPromptSubmit + SessionEnd + SessionStart (recovery) hooks into ~/.claude/settings.json",
  "memory scan":
    "Scan the memory store for stored secrets, or prompt-injection patterns with --injection (exit 1 on a high-confidence finding)",
  "memory backup": "Encrypted backup of the memory store (AES-256-GCM; KIT_MEMORY_PASSPHRASE)",
  "memory restore": "Restore an encrypted memory backup (e.g. on a new machine)",
  "memory share": "Promote a curated, secret-scanned entry to the shared (team) memory",
  "memory areas": "List shared responsibility areas (stripe, whatsapp, …)",
  "memory area": "Show shared entries for one area (decisions, how-built, status, security)",
  "memory context":
    "Push-surface active decisions for the area(s) whose files you're touching (deterministic, path→cluster)",
  "memory pal": "Pending action ledger — list/add/done/snooze/verify/import 'blocked-on-you' items",
  "memory save": "Bookmark the current session as a named copilot",
  "memory threads": "List saved copilots (current project; --global for all)",
  "memory resume": "Print the resume command for a saved copilot (by name or number)",
  init: "Detect stack, generate .kit.toml, and run full setup (--no-setup: config + lock files only)",
  upgrade: "Update lock files from .kit.toml",
  install: "Install missing tools via mise",
  login: "Guided login to all configured services",
  "login --plan":
    "Show the resolved auth strategy per service (vault/interactive/capture + passkey) without logging in",
  secrets: "Generate .env.local from template + secret store",
  "secrets sync": "Push resolved secrets to GitHub Actions / .env.ci / stdout",
  "secrets migrate": "Migrate plaintext secrets in .env* → configured vault",
  "secrets set":
    "Capture a value to the vault: kit secrets set <KEY> --stdin (safer) | --value <v>",
  "secrets rotate": "Rotate a key: write new value to vault (explicit / random)",
  "secrets onecli": "Register a key with OneCLI gateway so agent never sees the real value",
  "secrets purge-history":
    "Destructive: rewrite git history to remove a leaked value (--force-history)",
  "secrets propagate":
    "Push a value to deploy targets only (skips vault-write). --stdin safer than --value",
  "secrets revoke-old": "Revoke a previously-minted scoped key (Supabase Mgmt API)",
  "env switch": "Switch active environment (dev/staging/prod). Gates prod-key reads.",
  "env current": "Show active environment marker",
  analyze: "Analyze repo + emit draft CLAUDE.md / RULES.md",
  "agent-config":
    "Inject a managed 'use kit' block into CLAUDE.md / AGENTS.md / .cursorrules / .clinerules / .github/copilot-instructions.md",
  "gate-bash":
    "PreToolUse install-gate: read an agent's pending Bash command on stdin, block (exit 2) un-triaged installs",
  "gate-env":
    "PreToolUse env-gate: read an agent's pending Write/Edit on stdin, block (exit 2) plaintext secrets aimed at .env* files",
  security:
    "Security policy + scanners (policy | scan-staged | scan-build | verify-pull | prescan | …)",
  "security policy": "Dependency allowlist enforcement (init|add|check)",
  "security clear-cache": "Clear cached scanner binary (after intentional rebuild)",
  "security scan-staged": "Pre-commit: scan staged files for credential patterns",
  "security scan-build": "Scan build artifacts (.next/, dist/) for inlined secrets",
  "security scan-transcripts": "Scan agent transcripts + prompt caches for leaked credentials",
  "security costs": "Snapshot per-key spend vs policy cap (Stripe live; others stubbed)",
  "security check-gitignore": "Verify .gitignore covers sensitive paths (--fix to auto-patch)",
  "security verify-pull": "After git pull: audit new deps, gitignore drops, introduced secrets",
  "security prescan":
    "Multi-repo baseline sweep (secrets, gitignore, branch-protect; --deep adds CVE/workflow-drift/bumblebee; --format=json + --vs-baseline=<path> for CI drift)",
  "security prescan-diff":
    "Diff two prescan reports — surface new regressions + fixed findings since baseline",
  "audit secrets": "Forensics: who/what touched each key + when (reads audit log)",
  "audit verify":
    "Verify the audit log's keyless hash chain + HMAC anchor (--require-external demands a TSA receipt; exit 1 on break/forge/truncation)",
  "audit anchor":
    "Seal the audit log with the machine-local HMAC key (--external also gets a receipt from KIT_EXTERNAL_ANCHOR_CMD — closes the same-UID gap)",
  "audit export": "Emit the audit log for a SIEM (--format cef|syslog|json)",
  auth: "TOTP-gated elevation for destructive secret ops (elevate|status|revoke|setup-totp)",
  "auth elevate": "Mint elevation marker for destructive secret ops (TOTP/yes-prompt)",
  "auth status": "Show active elevation",
  "auth revoke": "Drop the elevation marker",
  "auth setup-totp": "Enroll TOTP secret (writes ~/.kit/totp-secret 0600)",
  "hooks add": "Install a built-in hook (e.g. secret-scan)",
  setup: "Full pipeline: install → login → secrets → agent config → verify",
  "setup --recommended":
    "Opinionated profile: setup + memory hooks + git secret-scan/context-check gates",
  fix: "Auto-fix what is possible",
  heal: "Loop: auto-fix safe findings, re-scan until green; gate destructive, fail-closed on tamper (--dry-run, --agent)",
  escalate: "List what needs human action",
  governance: "View governance status and agent access controls",
  skills: "Check status of agent skills",
  hooks: "Manage git hooks",
  add: "Provision a service (kit add --list to see all adapters)",
  audit: "View audit log of kit operations",
  doctor: "Deep diagnostics — checks environment health in detail",
  env: "Show current environment info",
  ci: "CI-native check: GitHub Actions annotations, GitLab JUnit, JSON (--init gitlab|bitbucket scaffolds a pipeline)",
  clone: "Clone a Git repository and run kit setup",
  run: "Execute a command with project env vars loaded",
  open: "Open service dashboard in browser (stripe, vercel, railway, etc.)",
  context: "Show project context: tools, services, secrets, environment",
  "context check":
    "Verify each CLI's live account+project matches .kit.toml [context] (exits non-zero on mismatch)",
  "context use": "Activate the declared context: gcloud config + repo git identity",
  "context --prompt": "Print a compact active-gcloud indicator for your shell prompt (PS1)",
  config: "Inspect + migrate the .kit.toml schema version",
  "config migrate":
    "Migrate .kit.toml to the current schema version (--dry-run inspect, --check CI gate, --force overwrite backup)",
  "config knobs": "List power-user env vars + .kit.toml fields kit honors (--json)",
  mcp: "MCP server over stdio (Claude Code/Cursor/Codex); 'kit mcp list|auth|set-token|clear' manages declared servers",
  whoami: "Show current agent / user identity",
  version: "Print kit version",
  "create-plugin": "Scaffold a new kit plugin package",
  plugin: "Discover and manage kit plugins (search, list, scaffold, install)",
  triage: "Security evaluation before installing packages, images, or skills",
  slopsquat: "Score npm/PyPI packages for hallucination/slopsquat risk (registry metadata)",
  pkg: "Install package with mandatory triage (kit pkg npm:express)",
  team: "Manage team members, roles, and permissions (RBAC, invitations, audit logs)",
  completions: "Output shell completion script (bash, zsh, fish)",
  help: "Show this help",
};

async function cmdPkg(): Promise<boolean> {
  const args = process.argv.slice(3);
  const input = args[0];

  if (!input || input === "--help" || input === "-h") {
    console.log(`${c.bold}kit pkg${c.reset} — Install packages with mandatory triage\n`);
    console.log("Usage:  kit pkg <ecosystem>:<package>[@version]\n");
    console.log("Ecosystems:");
    console.log("  npm:express            npm install express");
    console.log("  npm-g:vercel           npm install -g vercel");
    console.log("  pnpm:react             pnpm add react");
    console.log("  pip:requests           pip install requests");
    console.log("  brew:trivy             brew install trivy");
    console.log("  docker:postgres        docker pull postgres");
    console.log("  go:golang.org/x/tools/cmd/goimports@latest");
    console.log("  cargo:ripgrep          cargo install ripgrep");
    console.log("");
    console.log("Examples:");
    console.log("  kit pkg npm:express@4.18.0");
    console.log("  kit pkg pip:requests");
    console.log("  kit pkg docker:stalwartlabs/stalwart");
    console.log("  kit pkg brew:semgrep");
    return true;
  }

  const spec = parsePkgSpec(input);
  if (!spec) {
    console.error(`${c.red}Invalid format: ${input}${c.reset}`);
    console.error("Expected: <ecosystem>:<package> (e.g. npm:express, pip:requests)");
    return false;
  }

  console.log(
    `${c.bold}Installing ${spec.ecosystem}:${spec.name}${spec.version ? `@${spec.version}` : ""}${c.reset}\n`,
  );
  console.log(`${c.cyan}Step 1: Triage...${c.reset}`);

  const result = await installPkg(spec);
  console.log(result.output);

  return result.installed;
}

function cmdHelp(subcommand?: string): boolean {
  if (subcommand && COMMAND_HELP[subcommand]) {
    console.log(`kit ${subcommand} — ${COMMAND_HELP[subcommand]}`);
    return true;
  }

  const bold = c.bold,
    cyan = c.cyan,
    dim = c.dim,
    reset = c.reset,
    green = c.green;

  console.log(`${bold}kit${reset} ${dim}v${KIT_VERSION}${reset} — developer environment manager\n`);
  console.log(
    `${bold}Get going:${reset}  ${dim}npx sandstream-kit setup${reset}  ${dim}or${reset}  ${green}kit init${reset} ${dim}→${reset} ${green}kit check${reset} ${dim}→${reset} ${green}kit setup${reset}`,
  );
  console.log(
    `${dim}Prereqs: Node 22+, git, and mise (brew install mise) for installing tools.${reset}\n`,
  );
  console.log(`${bold}Usage:${reset}  kit ${cyan}<command>${reset} ${dim}[options]${reset}\n`);
  // Grouped command surface — far more scannable than a flat 75-line dump. Categories
  // cover every top-level command; any command not listed still prints under "Other",
  // so help can never silently drop one. Subcommands are reached via `kit <cmd> --help`
  // (or `kit help <cmd>`) rather than firehosed here.
  const CATEGORIES: [string, string[]][] = [
    [
      "Setup & lifecycle",
      [
        "init",
        "setup",
        "install",
        "upgrade",
        "clone",
        "fix",
        "heal",
        "doctor",
        "status",
        "check",
        "health",
      ],
    ],
    ["Review & quality", ["review", "design", "standards", "coverage", "baseline", "analyze"]],
    ["Secrets & environments", ["secrets", "env", "login"]],
    [
      "Security & supply chain",
      [
        "scan",
        "security",
        "triage",
        "supply-chain",
        "sbom",
        "gha-audit",
        "agent-audit",
        "verify-provenance",
        "ingest",
        "sentinel",
      ],
    ],
    ["Agents & memory", ["memory", "agent-config", "mcp", "skills", "context", "hooks"]],
    [
      "Governance & access",
      ["governance", "audit", "auth", "team", "escalate", "identity", "panic", "policy"],
    ],
    ["Packages & services", ["pkg", "add", "plugin", "create-plugin", "run", "open", "ci"]],
    ["Meta", ["whoami", "version", "completions", "help"]],
  ];

  // top-level keys have no space; subcommand keys ("memory index") do.
  const topLevel = Object.keys(COMMAND_HELP).filter((k) => !k.includes(" "));
  const categorized = new Set(CATEGORIES.flatMap(([, cmds]) => cmds));
  const uncategorized = topLevel.filter((k) => !categorized.has(k));
  const groups: [string, string[]][] = uncategorized.length
    ? [...CATEGORIES, ["Other", uncategorized]]
    : CATEGORIES;

  const hasSub = (cmd: string) => Object.keys(COMMAND_HELP).some((k) => k.startsWith(`${cmd} `));
  const maxLen = Math.max(...topLevel.map((k) => k.length)) + 2; // room for the " +" marker

  console.log(
    `${bold}Commands:${reset}  ${dim}(+ = has subcommands; run \`kit <command> --help\`)${reset}`,
  );
  for (const [title, cmds] of groups) {
    const present = cmds.filter((cmd) => COMMAND_HELP[cmd]);
    if (!present.length) continue;
    console.log(`\n  ${dim}${title}${reset}`);
    for (const cmd of present) {
      const label = hasSub(cmd) ? `${cmd} +` : cmd;
      const pad = " ".repeat(maxLen - label.length + 2);
      console.log(`  ${green}${label}${reset}${pad}${dim}${COMMAND_HELP[cmd]}${reset}`);
    }
  }

  console.log(`\n${bold}Options:${reset}`);
  console.log(`  ${green}--non-interactive${reset}  ${dim}No prompts (for CI / agent use)${reset}`);
  console.log(`  ${green}--json${reset}             ${dim}Machine-readable output${reset}`);
  console.log(
    `  ${green}--env=<name>${reset}       ${dim}Environment override (dev/staging/production)${reset}`,
  );
  console.log(
    `  ${green}--dry-run${reset}          ${dim}Preview without writing (where supported)${reset}`,
  );
  console.log(`  ${green}--help, -h${reset}         ${dim}Show this help${reset}`);
  console.log(`  ${green}--version, -v${reset}      ${dim}Print version${reset}`);

  console.log(`\n${bold}Examples:${reset}`);
  console.log(`  ${dim}kit init${reset}                       # Set up a new project`);
  console.log(`  ${dim}kit check --json${reset}               # Machine-readable status`);
  console.log(`  ${dim}kit add neon/db${reset}                # Provision Neon Postgres`);
  console.log(`  ${dim}kit secrets sync --target=github${reset} # Push secrets to GitHub Actions`);
  console.log(`  ${dim}kit ci --format=github${reset}         # CI check with PR annotations`);
  console.log(`  ${dim}kit add --list${reset}                 # List all available adapters`);

  return true;
}

async function cmdTeam(): Promise<boolean> {
  const subcommand = process.argv[3];
  const args = process.argv.slice(4);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(`${c.bold}kit team${c.reset} — manage team members and permissions\n`);
    console.log(`${c.bold}Usage:${c.reset}`);
    console.log(`  kit team create <name>                 Create new team`);
    console.log(`  kit team invite <email> --role=<role>  Invite user to team`);
    console.log(`  kit team members list                  List team members`);
    console.log(`  kit team member remove <email>         Remove team member`);
    console.log(`  kit team audit log [--limit=N]         View audit logs\n`);
    console.log(`${c.dim}Roles: owner, admin, developer, guest${c.reset}`);
    return true;
  }

  try {
    switch (subcommand) {
      case "create": {
        const name = args[0];
        if (!name) {
          console.error(`${c.red}Error: team name required${c.reset}`);
          return false;
        }

        // Placeholder: would need user context from auth
        console.log(`${c.yellow}Note: Team creation requires authentication${c.reset}`);
        console.log(`${c.dim}Team management requires backend service integration${c.reset}`);
        return false;
      }

      case "invite": {
        const email = args[0];
        const roleArg = args.find((a) => a.startsWith("--role="));
        const role = roleArg?.split("=")[1] || "developer";

        if (!email) {
          console.error(`${c.red}Error: email required${c.reset}`);
          return false;
        }

        // No backend exists — do NOT print "Invitation sent" for a no-op (that is a
        // literal false-green, the exact thing kit's thesis condemns). Fail honestly.
        console.error(
          `${c.red}Error: kit team invite is not implemented — no team backend is configured${c.reset}`,
        );
        console.error(
          `${c.dim}would invite ${email} as ${role}; team management requires backend service integration${c.reset}`,
        );
        return false;
      }

      case "members": {
        if (args[0] !== "list") {
          console.error(`${c.red}Unknown subcommand: ${args[0]}${c.reset}`);
          return false;
        }

        console.log(`${c.bold}Team Members${c.reset}\n`);
        console.log(`${c.dim}(Requires team context — run from project with .kit.toml)${c.reset}`);
        return false;
      }

      case "member": {
        if (args[0] !== "remove") {
          console.error(`${c.red}Unknown subcommand: ${args[0]}${c.reset}`);
          return false;
        }

        const email = args[1];
        if (!email) {
          console.error(`${c.red}Error: email required${c.reset}`);
          return false;
        }

        // No backend — never claim a removal that did not happen. Fail honestly.
        console.error(
          `${c.red}Error: kit team member remove is not implemented — no team backend is configured${c.reset}`,
        );
        console.error(
          `${c.dim}would remove ${email}; team management requires backend service integration${c.reset}`,
        );
        return false;
      }

      case "audit": {
        if (args[0] !== "log") {
          console.error(`${c.red}Unknown subcommand: ${args[0]}${c.reset}`);
          return false;
        }

        const limitArg = args.find((a) => a.startsWith("--limit="));
        const limit = limitArg ? parseInt(limitArg.split("=")[1]) : 50;

        console.log(`${c.bold}Audit Log${c.reset}  ${c.dim}(limit: ${limit})${c.reset}\n`);
        console.log(`${c.dim}No audit events available${c.reset}`);
        return true;
      }

      default:
        console.error(`${c.red}Unknown subcommand: ${subcommand}${c.reset}`);
        console.error(`Run 'kit team --help' for usage information.`);
        return false;
    }
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`${c.red}Error: ${error.message}${c.reset}`);
    return false;
  }
}

/**
 * Surfaces commits that bypassed the pre-commit hook (`git commit
 * --no-verify`). The post-commit detector installed by `kit hooks
 * install` writes one JSONL line per skip to `.kit-skipped-commits.jsonl`;
 * we read the last few lines and print a red banner on stderr so the next
 * `kit` invocation makes the bypass visible. Suppressed when
 * `KIT_HIDE_HOOK_SKIP_BANNER=1` (useful for ephemeral CI).
 */
async function showSkippedCommitBanner(): Promise<void> {
  if (process.env.KIT_HIDE_HOOK_SKIP_BANNER === "1") return;
  try {
    const { readFile, stat } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const logPath = resolve(process.cwd(), SKIPPED_COMMITS_LOG);
    const info = await stat(logPath).catch(() => null);
    if (!info) return;
    const content = await readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return;
    const recent = lines.slice(-3);
    process.stderr.write(
      `${c.red}[kit] ${lines.length} commit(s) bypassed pre-commit hook — most recent:${c.reset}\n`,
    );
    for (const line of recent) {
      try {
        const entry = JSON.parse(line) as { timestamp: string; sha: string; reason: string };
        process.stderr.write(`  ${entry.timestamp}  ${entry.sha.slice(0, 8)}  (${entry.reason})\n`);
      } catch {
        /* malformed line — ignore */
      }
    }
    process.stderr.write(
      `  Review: cat ${SKIPPED_COMMITS_LOG} | jq .\n` + `  Suppress: KIT_HIDE_HOOK_SKIP_BANNER=1\n`,
    );
  } catch {
    /* banner is best-effort — never break the CLI */
  }
}

/**
 * `kit memory` — local conversation memory (SQLite + FTS5). Deterministic and
 * zero-LLM: it stores raw transcripts and searches them; it never calls a model.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const nonInteractive =
    hasFlag(args, "--non-interactive") ||
    process.env.CI === "true" ||
    process.env.GITHUB_ACTIONS === "true";

  // Activate read-only mode early so subsequent code paths see the env var.
  // Honored gates: writeSecretToBackend, grantElevation, installHooks, and
  // every kit-plugin write surface (vercel env-set, github secret-put,
  // stripe webhook-create, etc).
  if (hasFlag(args, "--read-only") || hasFlag(args, "--readonly")) {
    const { activateReadOnlyMode } = await import("./read-only-mode.js");
    activateReadOnlyMode("flag");
  } else if (process.env.KIT_READ_ONLY === "1") {
    const { activateReadOnlyMode } = await import("./read-only-mode.js");
    activateReadOnlyMode("env");
  }

  // Compute + export KIT_POLICY_HASH so classifiers / agents reading
  // the env see the same policy identity. Also honors
  // `[policy].default_mode = "read-only"` as a third source for the
  // read-only gate above (after flag + env-var).
  try {
    const cfgForPolicy = await loadConfig(resolveConfigPath()).catch(() => null);
    if (cfgForPolicy?.policy) {
      const { installPolicyHash } = await import("./policy.js");
      installPolicyHash(cfgForPolicy.policy);
      if (cfgForPolicy.policy.default_mode === "read-only" && !process.env.KIT_READ_ONLY) {
        const { activateReadOnlyMode } = await import("./read-only-mode.js");
        activateReadOnlyMode("policy");
      }
    }
  } catch {
    /* config not loadable at boot — non-fatal; subcommands re-load as needed */
  }

  await showSkippedCommitBanner();

  try {
    let ok: boolean;

    // --version / --help flags before the switch
    if (args[0] === "--version" || args[0] === "-v") {
      ok = cmdVersion();
      process.exitCode = ok ? 0 : 1;
      return;
    }
    if (args[0] === "--help" || args[0] === "-h") {
      ok = cmdHelp();
      process.exitCode = 0;
      return;
    }
    // A `--help`/`-h` anywhere after the command means "show that command's
    // help" — NEVER execute the command. Critical for side-effectful commands
    // (agent-config, fix, secrets, hooks add): `kit <cmd> --help` previously
    // fell through to the dispatch and ran <cmd>. (Generalizes the 1.4.0 fix
    // that only covered `kit memory <sub> --help`.)
    if (command && command !== "help" && (hasFlag(args, "--help") || hasFlag(args, "-h"))) {
      cmdHelp(command);
      process.exitCode = 0;
      return;
    }

    // version/help/completions need bespoke handling; everything else is a flat
    // command->fn dispatch (was a ~40-case switch — the main complexity driver).
    if (command === "version") {
      ok = cmdVersion();
    } else if (command === "help") {
      ok = cmdHelp(args[1]);
    } else if (command === "completions") {
      const shell = args[1];
      const script = generateCompletions(shell);
      if (!script) {
        console.error(`Unknown shell: ${shell}. Use: bash, zsh, fish`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(script);
      ok = true;
    } else {
      // no command → `check` (the prior `case undefined` behaviour).
      // COMMANDS is the module-scope dispatch table (single source of truth for the
      // command surface; help coverage is verified against it in command-surface.test.ts).
      const resolved = command ?? "check";
      const handler = COMMANDS[resolved];
      if (handler) {
        emitDeprecationWarning(resolved);
        ok = await handler();
      } else {
        console.error(`Unknown command: ${command}`);
        const { didYouMean } = await import("./utils/didYouMean.js");
        const knownCommands = [
          ...new Set(Object.keys(COMMAND_HELP).map((k) => k.split(" ")[0])),
          "help",
          "version",
          "completions",
        ];
        const suggestions = didYouMean(command, knownCommands);
        if (suggestions.length > 0) {
          console.error(`Did you mean: ${suggestions.map((s) => `'${s}'`).join(", ")}?`);
        }
        console.error(`Run 'kit help' for a list of available commands.`);
        process.exitCode = 1;
        return;
      }
    }

    process.exitCode = ok ? 0 : 1;

    // Non-interactive / CI: skip update check. Also skip in --json mode: the notice
    // prints to stdout and would corrupt a machine-readable JSON payload (e.g.
    // `kit check --json` piped to a parser).
    if (!nonInteractive && !hasFlag(args, "--json")) {
      checkForUpdate(KIT_VERSION)
        .then((info) => {
          if (info) printUpdateNotice(info);
        })
        .catch(() => {}); // never fail
    }
  } catch (err: unknown) {
    const code =
      err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
    const jsonMode = hasFlag(args, "--json");
    if (code === "ENOENT") {
      // In --json mode emit a valid JSON error so consumers never get empty stdout.
      if (jsonMode) console.log(JSON.stringify({ ok: false, error: `${KIT_FILE} not found` }));
      console.error(`${c.red}Error: ${KIT_FILE} not found in ${process.cwd()}${c.reset}`);
      console.error(
        `${c.dim}Create a .kit.toml to define your project's tools, services, and secrets.${c.reset}`,
      );
      process.exitCode = 1;
    } else if (code === "KIT_INVALID_CONFIG") {
      // A malformed .kit.toml (bad TOML syntax or failed schema validation) must fail
      // CLOSED like a missing one — a clean error + exit 1, never an uncaught stack
      // trace with empty --json stdout (a denial-of-verdict any dropped file could cause).
      const msg = err instanceof Error ? err.message : String(err);
      if (jsonMode) console.log(JSON.stringify({ ok: false, error: msg }));
      console.error(`${c.red}${msg}${c.reset}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

/**
 * `kit gate-bash` — PreToolUse install-gate handler. Reads a coding agent's
 * pending-tool-call JSON on stdin ({ tool_name, tool_input: { command } }), and
 * if it is a Bash command that adds an un-triaged package, BLOCKS it by exiting 2
 * (the deny signal for Claude Code / Codex / Amazon Q PreToolUse hooks; exit 1
 * would be a non-blocking error). Allow → exit 0. This is what makes
 * "installs nothing untriaged" hold even in agent auto-mode. Wire it with
 * `kit agent-config --install-gate`. Pure decision lives in install-gate.ts.
 */
export async function cmdGateBash(): Promise<boolean> {
  let raw = "";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks).toString("utf8");
  } catch {
    return true; // no stdin / read error → do not block
  }
  let payload: {
    tool_name?: string;
    tool_input?: { command?: unknown };
    command?: unknown;
    preToolUse?: { toolName?: string; parameters?: { command?: unknown } };
  };
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return true; // unparseable hook payload → do not block (avoid breaking the agent)
  }
  // Agent-agnostic command extraction (Claude/Codex/Amazon Q/Gemini tool_input.command,
  // Cursor top-level command, Cline preToolUse.parameters.command) — shared pure helper.
  const { decideBashGate, extractCommandFromHookPayload } = await import("./install-gate.js");
  const command = extractCommandFromHookPayload(payload);
  if (!command) {
    return true; // no shell command in this tool call → allow
  }
  const verdict = await decideBashGate(command);
  if (verdict.block) {
    // Cline blocks via a stdout JSON {cancel:true} contract (HookOutputSchema),
    // NOT exit 2 — so `--format cline` emits that and exits 0; every other agent
    // uses the exit-2 PreToolUse deny.
    if (gateFormat() === "cline") {
      console.log(
        JSON.stringify({
          cancel: true,
          errorMessage: `kit install-gate: ${verdict.reason} — triage first (kit triage …) or install via kit pkg <eco>:<name>`,
        }),
      );
      return true;
    }
    const { writeSync } = await import("node:fs");
    writeSync(
      2,
      `kit install-gate: BLOCKED — ${verdict.reason}\nTriage it first: \`kit triage …\`, or install via \`kit pkg <eco>:<name>\`.\n`,
    );
    process.exit(2); // PreToolUse deny
  }
  return true;
}

/**
 * PreToolUse hook body for the env-write-gate: block a Write/Edit that puts a
 * plaintext secret into a real `.env*` file, BEFORE it lands. Mirrors gate-bash:
 * fail-open on unparseable payloads (never break the agent), exit-2 deny on block.
 */
export async function cmdGateEnv(): Promise<boolean> {
  let raw = "";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks).toString("utf8");
  } catch {
    return true; // no stdin / read error → do not block
  }
  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return true; // unparseable hook payload → do not block (avoid breaking the agent)
  }
  const { extractWriteFromHookPayload, decideEnvWriteGate } = await import("./env-write-gate.js");
  const write = extractWriteFromHookPayload(payload);
  if (!write) return true; // not a file write → allow
  const verdict = decideEnvWriteGate(write.filePath, write.text);
  if (verdict.block) {
    if (gateFormat() === "cline") {
      console.log(
        JSON.stringify({
          cancel: true,
          errorMessage: `kit env-gate: ${verdict.reason} — resolve secrets with \`kit secrets\` (vault-backed) instead of plaintext .env`,
        }),
      );
      return true;
    }
    const { writeSync } = await import("node:fs");
    writeSync(
      2,
      `kit env-gate: BLOCKED — ${verdict.reason}\nNever write secrets to .env* in plaintext. Resolve them with \`kit secrets\` (vault-backed), or use a placeholder in .env.example.\n`,
    );
    process.exit(2); // PreToolUse deny
  }
  return true;
}

/** The `--format <fmt>` value for gate-bash (`--format cline` | `--format=cline`). */
function gateFormat(): string {
  const argv = process.argv;
  const eq = argv.find((a) => a.startsWith("--format="));
  if (eq) return eq.slice("--format=".length);
  const i = argv.indexOf("--format");
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : "";
}

// Single source of truth for kit's top-level command surface. Every key here MUST
// have a COMMAND_HELP entry — command-surface.test.ts fails the build otherwise, so
// `kit help` and the did-you-mean suggestions can never silently drift from dispatch.
// Declared at module scope (after every cmd* handler) so the coverage test can import
// it without running the CLI; referenced by main() above, which only runs as the entry.
export const COMMANDS: Record<string, () => boolean | Promise<boolean>> = {
  status: cmdStatus,
  statusline: cmdStatusline,
  whoami: cmdWhoami,
  check: cmdCheck,
  health: cmdHealth,
  ingest: cmdIngest,
  "supply-chain": cmdSupplyChain,
  "agent-audit": cmdAgentAudit,
  sentinel: cmdSentinel,
  scan: cmdScan,
  airgap: cmdAirgap,
  "verify-provenance": cmdVerifyProvenance,
  "gha-audit": cmdGhaAudit,
  sbom: cmdSbom,
  init: cmdInit,
  upgrade: cmdUpgrade,
  install: cmdInstall,
  login: cmdLogin,
  secrets: cmdSecrets,
  setup: cmdSetup,
  skills: cmdSkills,
  fix: cmdFix,
  heal: cmdHeal,
  escalate: cmdEscalate,
  governance: cmdGovernance,
  "agent-config": cmdAgentConfig,
  hooks: cmdHooks,
  add: cmdAdd,
  audit: cmdAudit,
  auth: cmdAuth,
  mcp: cmdMcp,
  env: cmdEnv,
  doctor: cmdDoctor,
  analyze: cmdAnalyze,
  security: cmdSecurity,
  "create-plugin": cmdCreatePlugin,
  plugin: cmdPlugin,
  ci: cmdCi,
  "self-audit": cmdSelfAudit,
  coverage: cmdCoverage,
  identity: cmdIdentity,
  panic: cmdPanic,
  policy: cmdPolicy,
  clone: cmdClone,
  run: cmdRun,
  open: cmdOpen,
  context: cmdContext,
  config: cmdConfig,
  triage: cmdTriage,
  slopsquat: cmdSlopsquat,
  baseline: cmdBaseline,
  design: cmdDesign,
  standards: cmdStandards,
  review: cmdReview,
  pkg: cmdPkg,
  team: cmdTeam,
  memory: cmdMemory,
  "gate-bash": cmdGateBash,
  "gate-env": cmdGateEnv,
};

/**
 * Stability tier for a top-level command. Part of kit's frozen command surface
 * (kit 2.x). See docs/CLI_STABILITY.md.
 *   stable       Covered by the 2.x compatibility promise; will not break.
 *   experimental Shipped but may change shape across minor versions.
 *   deprecated   Slated for removal in a future major; prints a runtime warning.
 */
export type CommandTier = "stable" | "experimental" | "deprecated";

// Stability tier for every top-level command. Keyed by the SAME names as COMMANDS
// and COMMAND_HELP. command-surface.test.ts enforces 3-way parity: every COMMANDS
// key has both a tier here and a help entry, so the surface can never drift.
// Default is "stable" (shipped commands honor the 2.x promise); "team" is the
// placeholder RBAC command (backend not wired) so it ships as "experimental".
export const COMMAND_TIERS: Record<string, CommandTier> = {
  status: "stable",
  statusline: "stable",
  whoami: "stable",
  check: "stable",
  health: "stable",
  ingest: "stable",
  "supply-chain": "stable",
  "agent-audit": "stable",
  sentinel: "stable",
  scan: "stable",
  airgap: "stable",
  "verify-provenance": "stable",
  "gha-audit": "stable",
  sbom: "stable",
  init: "stable",
  upgrade: "stable",
  install: "stable",
  login: "stable",
  secrets: "stable",
  setup: "stable",
  skills: "stable",
  fix: "stable",
  heal: "stable",
  escalate: "stable",
  governance: "stable",
  "agent-config": "stable",
  hooks: "stable",
  add: "stable",
  audit: "stable",
  auth: "stable",
  mcp: "stable",
  env: "stable",
  doctor: "stable",
  analyze: "stable",
  security: "stable",
  "create-plugin": "stable",
  plugin: "stable",
  ci: "stable",
  "self-audit": "stable",
  coverage: "experimental",
  identity: "experimental",
  panic: "experimental",
  policy: "experimental",
  clone: "stable",
  run: "stable",
  open: "stable",
  context: "stable",
  config: "stable",
  triage: "stable",
  slopsquat: "experimental",
  baseline: "stable",
  design: "stable",
  standards: "stable",
  review: "stable",
  pkg: "stable",
  team: "experimental",
  memory: "stable",
  "gate-bash": "experimental",
  "gate-env": "experimental",
};

/**
 * Emit a deprecation warning to stderr when a command's tier is "deprecated".
 * Returns true when a warning was emitted. Pure + parameterized so the mechanism
 * is unit-testable with a fixture tiers map and a spy writer; main() calls it
 * with the real COMMAND_TIERS and console.error. Warnings go to stderr so they
 * never pollute machine-readable stdout (e.g. --json).
 */
export function emitDeprecationWarning(
  command: string,
  tiers: Record<string, CommandTier> = COMMAND_TIERS,
  write: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): boolean {
  if (tiers[command] !== "deprecated") return false;
  write(
    `warning: 'kit ${command}' is deprecated and will be removed in a future major version. See docs/CLI_STABILITY.md.`,
  );
  return true;
}

// Run only when invoked as the real CLI entry — NOT when imported by a test
// (command-surface.test.ts imports COMMANDS/COMMAND_HELP). main() handles its own
// errors and sets process.exitCode; `void` marks the intentional non-await.
function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntry()) void main();
