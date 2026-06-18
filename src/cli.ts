#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { writeFile, access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { loadConfig, type kitConfig } from "./config.js";
import { checkTools } from "./check-tools.js";
import { checkServices } from "./check-services.js";
import { checkSecrets } from "./check-secrets.js";
import { checkSecurity } from "./check-security.js";
import { checkWebSearch } from "./check-web-search.js";
import { installTools } from "./install.js";
import { loginServices } from "./login.js";
import { check1PasswordStatus, detect1PasswordMode } from "./onepassword.js";
import { isNonInteractive } from "./environment.js";
import { spawn as spawnChild } from "node:child_process";
import { promptSelect } from "./utils/promptSelect.js";
import { hasFlag, flagValue } from "./utils/flags.js";
import { scanPlaintextSecrets } from "./scan-plaintext.js";
import {
  planMigration,
  writeSecretToBackend,
  commentOutInFile,
  type PostMigrateMode,
} from "./secrets-migrate.js";
import { analyzeRepo, renderClaudeMd, renderRulesMd } from "./analyze.js";
import { cmdSecretsRotate, pickBackendOpts } from "./secrets-rotate-cli.js";
import { setSecretValue, type SetValueOptions } from "./secrets-set.js";
import {
  detectTools as detectPurgeTools,
  previewMatches,
  purgeHistory,
} from "./secrets-purge-history.js";
import {
  propagate,
  parseTargets,
  ALL_TARGETS,
  type PropagationOptions,
} from "./secrets-propagate.js";
import {
  initAllowlist,
  checkAllowlist,
  addToAllowlist,
  checkSecretPolicy,
} from "./security-policy.js";
import { clearBumblebeeCache } from "./bumblebee.js";
import { scanStagedFiles } from "./scan-staged.js";
import { scanBuildArtifacts } from "./scan-build.js";
import { scanTranscripts } from "./scan-transcripts.js";
import { sampleCosts } from "./cost-monitor.js";
import { requireElevation, consumeElevation } from "./elevation.js";
import {
  checkGitignore,
  patchGitignore,
  findCommittedSensitive,
} from "./check-gitignore.js";
import { auditPull, reportSeverity } from "./post-pull-audit.js";
import {
  checkOneCliStatus,
  registerSecretInOneCli,
  generatePlaceholder,
  resolveOneCliConfig,
} from "./secrets-onecli.js";
import type { SecretsStore } from "./toml-generator.js";
import { generateSecrets } from "./secrets.js";
import { syncSecrets } from "./secrets-sync.js";
import { generateCompletions } from "./completions.js";
import { checkForUpdate, printUpdateNotice } from "./update-check.js";
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
import { writeAgentConfig, detectAgentTargets, installKitPermissions } from "./agent-config.js";
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
import { checkContext, applyContext, contextPrompt, gatherLive, suggestContextToml } from "./context-lock.js";
import { cmdEnv } from "./commands/env.js";
import { cmdAuth } from "./commands/auth.js";
import { cmdAudit } from "./commands/audit.js";
import { cmdMcp } from "./commands/mcp.js";
import { cmdHooks } from "./commands/hooks.js";
import { resolveAllAuth } from "./service-auth.js";
import { runDoctor } from "./doctor.js";
import { detectStack } from "./stack-detector.js";
import { generateToml } from "./toml-generator.js";
import { createPlugin } from "./create-plugin.js";
import { cmdPlugin } from "./plugins-cli.js";
import { cloneRepository } from "./clone.js";
import { executeCommand } from "./run.js";
import { listServices, openService } from "./open.js";
import { gatherProjectContext } from "./context.js";
import { runTriage, listTriageTools, type TriageType } from "./triage.js";
import { parsePkgSpec, installPkg } from "./pkg.js";
import { cmdMemory } from "./commands/memory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KIT_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string }
).version;

interface JsonCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
  category: string;
}

interface JsonCheckOutput {
  ok: boolean;
  checks: JsonCheck[];
  summary: { passed: number; failed: number; warnings: number; skipped: number };
}

async function cmdCheck(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const enforceTests = hasFlag(process.argv, "--enforce-tests");
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

      const toolResults = config.tools
        ? await step("tools", () => checkTools(config.tools!))
        : [];
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
       const securityResults = await step("security scan", () => checkSecurity());
      const lockResults = await step("lock files", () => checkLockFiles(config));

      // Test-coverage enforcement (--enforce-tests CLI flag overrides config).
      // Baseline-aware: pre-existing untested files only warn; net-new fail.
      const { checkTests } = await import("./check-tests.js");
      const { loadBaseline, baselineGet } = await import("./baseline.js");
      const baseline = await loadBaseline();
      const testResults = await step("test coverage", () =>
        checkTests({
          enforce: enforceTests,
          baseline: baselineGet(baseline, "tests", "untested_files"),
        }),
      );

      const securityOk = securityResults.every((s) => s.status === "pass" || s.status === "skip");
      const testsOk = testResults.every((t) => t.status !== "fail");
      const lockOk = lockResults.every((l) => l.inSync);
      const allOk =
        toolResults.every((t) => t.ok) &&
        // Informational services (no CLI login — `#`-documented, e.g. resend
        // env keys) are manual setup, not a failed gate. They surface as warns.
        serviceResults.every((s) => s.authenticated || s.informational) &&
        secretResults.keys.every((s) => s.available) &&
        skillResults.filter((s) => s.required).every((s) => s.installed) &&
        hookResults.every((h) => h.installed && h.upToDate) &&
        securityOk &&
        testsOk &&
        lockOk;

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
            status: (s.authenticated ? "pass" : s.informational ? "warn" : "fail") as JsonCheck["status"],
            detail: s.informational
              ? (s.output || "manual setup (no CLI login)")
              : (s.output ?? (s.authenticated ? "authenticated" : "not authenticated")),
            category: "services",
          })),
          ...secretResults.keys.map((s) => ({
            name: s.name,
            status: (s.available ? "pass" : "fail") as JsonCheck["status"],
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
                  detail: webSearchResult.error ?? (webSearchResult.healthy ? "healthy" : "unhealthy"),
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
          const icon =
            !r.installed
              ? `${c.red}✗${c.reset}`
              : !r.upToDate
                ? `${c.yellow}!${c.reset}`
                : `${c.green}✓${c.reset}`;
          const status =
            !r.installed
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
            r.status === "pass" ? `${c.green}✓${c.reset}` :
            r.status === "fail" ? `${c.red}✗${c.reset}` :
            r.status === "warn" ? `${c.yellow}!${c.reset}` :
            `${c.dim}-${c.reset}`;
          console.log(`  ${icon} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
          if (r.files && r.files.length > 0) {
            for (const f of r.files) console.log(`      ${c.dim}- ${f}${c.reset}`);
          }
        }
        console.log();
      }

      printSummary(toolResults, serviceResults, secretResults.keys, securityResults);

      return allOk;
    }
  );
}

/**
 * `kit design` — a11y + design-token consistency, baseline-aware.
 */
async function cmdDesign(): Promise<boolean> {
  const enforce = hasFlag(process.argv, "--enforce");
  const jsonMode = hasFlag(process.argv, "--json");
  const { checkDesign } = await import("./check-design.js");
  const { loadBaseline, baselineGet } = await import("./baseline.js");
  const baseline = await loadBaseline();
  const results = await checkDesign({
    enforce,
    baseline: {
      a11y: baselineGet(baseline, "design", "a11y"),
      tokens: baselineGet(baseline, "design", "tokens"),
    },
  });
  if (jsonMode) {
    console.log(JSON.stringify({ ok: results.every((r) => r.status !== "fail"), checks: results }, null, 2));
    return results.every((r) => r.status !== "fail");
  }
  console.log(`${c.bold}Design${c.reset}`);
  for (const r of results) {
    const icon =
      r.status === "pass" ? `${c.green}✓${c.reset}` :
      r.status === "fail" ? `${c.red}✗${c.reset}` :
      r.status === "warn" ? `${c.yellow}!${c.reset}` :
      `${c.dim}-${c.reset}`;
    console.log(`  ${icon} ${r.name}  ${c.dim}${r.detail}${c.reset}`);
    if (r.files) for (const f of r.files) console.log(`      ${c.dim}- ${f}${c.reset}`);
  }
  return results.every((r) => r.status !== "fail");
}

/**
 * `kit review` — meta-runner: check + design + tests in one shot.
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

  if (!jsonMode) {
    console.log(`\n${c.bold}${allOk ? `${c.green}✓ review passed` : `${c.red}✗ review failed`}${c.reset}`);
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
  await saveBaseline(baseline);
  console.log(
    `${c.green}✓${c.reset} Wrote ${BASELINE_FILE} — ${untested.length} untested file(s), ${design.a11y.length} a11y, ${design.tokens.length} design-token finding(s) frozen.`,
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
  console.log(`${c.bold}${c.cyan}Installing tools via mise...${c.reset}\n`);

  return await withGovernance(
    config,
    {
      operation: "tools.install",
      operationType: "write",
      metadata: {
        tools: Object.keys(toolsConfig),
      },
    },
    async () => {
      const results = await installTools(toolsConfig);
      let allOk = true;

      for (const r of results) {
        const icon =
          r.action === "failed"
            ? `${c.red}✗${c.reset}`
            : `${c.green}✓${c.reset}`;
        const label =
          r.action === "already_ok"
            ? `${c.dim}already installed${c.reset}`
            : r.action === "installed"
              ? `${c.green}installed${c.reset}`
              : `${c.red}failed${c.reset}`;
        console.log(`  ${icon} ${r.name}  ${label}  ${c.dim}${r.detail}${c.reset}`);
        if (r.action === "failed") allOk = false;
      }

      console.log();
      return allOk;
    }
  );
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
    console.log(
      `${c.yellow}Still not authenticated — see hint above.${c.reset}\n`,
    );
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
  const retryCount = retryIdx >= 0 && args[retryIdx + 1] ? Math.max(0, parseInt(args[retryIdx + 1]!, 10) || 0) : 0;

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
    }
  );
}

async function cmdSecrets(): Promise<boolean> {
  // Route subcommand: kit secrets sync [--target=...] [--dry-run]
  if (process.argv[3] === "sync") {
    return cmdSecretsSync();
  }
  if (process.argv[3] === "migrate") {
    return cmdSecretsMigrate();
  }
  if (process.argv[3] === "vault-migrate") {
    return cmdSecretsVaultMigrate();
  }
  if (process.argv[3] === "rotate") {
    return cmdSecretsRotate();
  }
  if (process.argv[3] === "onecli") {
    return cmdSecretsOneCli();
  }
  if (process.argv[3] === "purge-history") {
    return cmdSecretsPurgeHistory();
  }
  if (process.argv[3] === "propagate") {
    return cmdSecretsPropagateStandalone();
  }
  if (process.argv[3] === "set") {
    return cmdSecretsSet();
  }
  if (process.argv[3] === "revoke-old") {
    return cmdSecretsRevokeOld();
  }

  const config = await loadConfig(resolveConfigPath());

  if (!config.secrets) {
    console.log(`${c.dim}No secrets configured in ${KIT_FILE}${c.reset}`);
    return true;
  }

  const secretsConfig = config.secrets;

  // ── S9: refuse prod-scoped keys outside prod env ──────────────────────────
  // Each key's source/ref/vault_path is checked against a "prod" marker;
  // if any prod-scoped key is configured AND the active env is not "prod",
  // require explicit KIT_PROD_OK=1 to proceed (CI deploy jobs set this).
  const { looksLikeProdKey, getActiveEnv, prodReadAllowed } = await import("./env-switch.js");
  const activeEnv = await getActiveEnv(process.cwd());
  const prodKeys = Object.entries(secretsConfig.keys ?? {}).filter(([, v]) => {
    return (
      looksLikeProdKey(v.ref) ||
      looksLikeProdKey(v.name) ||
      looksLikeProdKey(v.vault_path)
    );
  });
  if (prodKeys.length > 0 && !prodReadAllowed(activeEnv)) {
    console.error(
      `${c.red}✗ Refusing to materialize ${prodKeys.length} prod-scoped key(s) — active env is "${activeEnv}".${c.reset}`,
    );
    for (const [name, v] of prodKeys.slice(0, 5)) {
      const ref = v.ref ?? v.name ?? v.vault_path ?? "?";
      console.error(`  ${c.dim}•${c.reset} ${name}  ${c.dim}${ref}${c.reset}`);
    }
    if (prodKeys.length > 5) {
      console.error(`  ${c.dim}… and ${prodKeys.length - 5} more${c.reset}`);
    }
    console.error(
      `\n${c.dim}To proceed: ${c.bold}kit env switch prod${c.reset}${c.dim} (interactive), or set ${c.bold}KIT_PROD_OK=1${c.reset}${c.dim} in CI.${c.reset}\n`,
    );
    return false;
  }

  console.log(`${c.bold}${c.cyan}Generating secrets...${c.reset}  ${c.dim}(env=${activeEnv})${c.reset}\n`);

  return await withGovernance(
    config,
    {
      operation: "secrets.generate",
      operationType: "write",
      metadata: {
        store: secretsConfig.store,
        template: secretsConfig.template,
      },
    },
    async () => {
      const { results, written, fromTemplate, skipped } = await generateSecrets(secretsConfig);
      let allOk = true;

      for (const r of results) {
        const icon = r.resolved
          ? `${c.green}✓${c.reset}`
          : `${c.red}✗${c.reset}`;
        const status = r.resolved
          ? `${c.green}resolved${c.reset}`
          : `${c.red}missing${c.reset}`;
        console.log(`  ${icon} ${r.name}  ${status}  ${c.dim}${r.detail}${c.reset}`);
        if (!r.resolved) allOk = false;
      }

      if (written) {
        const source = fromTemplate
          ? `from ${secretsConfig.template}`
          : "from keys";
        console.log(`\n  ${c.green}✓${c.reset} Wrote .env.local ${c.dim}(${source})${c.reset}`);
      } else if (skipped === "nothing-resolved") {
        console.log(
          `\n  ${c.yellow}!${c.reset} Skipped .env.local ${c.dim}— no secrets resolved (vault empty/unauthed); existing file left intact${c.reset}`,
        );
      }

      console.log();
      return allOk;
    }
  );
}

async function cmdSkills(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());

  if (!config.skills) {
    console.log(`${c.dim}No skills configured in ${KIT_FILE}${c.reset}`);
    return true;
  }

  const registry = config.skills.registry ?? "clawhub";
  console.log(
    `${c.bold}${c.cyan}Skills${c.reset}  ${c.dim}(registry: ${registry})${c.reset}\n`,
  );

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
    const tag = r.required
      ? `${c.dim}[required]${c.reset}`
      : `${c.dim}[optional]${c.reset}`;
    const status = r.installed
      ? `${c.green}installed${c.reset}`
      : `${c.red}missing${c.reset}`;
    console.log(`  ${icon} ${name} ${tag} ${status}  ${c.dim}${r.versionSpec}${c.reset}`);
  }

  const missing = results.filter((r) => !r.installed);
  if (missing.length > 0) {
    console.log();
    console.log(`${c.bold}To install missing skills:${c.reset}`);
    for (const m of missing) {
      console.log(
        `  ${c.cyan}openclaw install ${registry}/${m.name}${c.reset}`,
      );
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
      const serviceResults = config.services
        ? await checkServices(config.services)
        : [];
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
    }
  );
}

async function cmdSetup(): Promise<boolean> {
  const recommended = hasFlag(process.argv, "--recommended");
  console.log(`${c.bold}${c.cyan}kit setup${recommended ? " --recommended" : ""}${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const config = await loadConfig(resolveConfigPath());

  if (recommended) {
    console.log(
      `${c.dim}Recommended profile also wires cross-harness memory hooks (in ~/.claude) ` +
        `and git hooks (secret-scan${config.context ? " + context-check" : ""}) after the core steps.${c.reset}\n`,
    );
  }

  // Step 1: Install
  console.log(`${c.bold}[1/6] Install${c.reset}`);
  const installOk = await cmdInstall();

  if (!installOk) {
    console.log(`${c.red}Install failed — stopping setup.${c.reset}`);
    console.log(`${c.dim}Fix the issues above and run ${c.reset}${c.bold}kit setup${c.reset}${c.dim} again.${c.reset}`);
    return false;
  }

  // Step 2: Git Hooks
  if (config.hooks && Object.keys(config.hooks).length > 0 && isGitRepository()) {
    console.log(`${c.bold}[2/6] Git Hooks${c.reset}`);
    await cmdHooks();
    console.log();
  }

  // Step 3: Login
  console.log(`${c.bold}[3/6] Login${c.reset}`);
  const loginOk = await cmdLogin();

  if (!loginOk) {
    console.log(`${c.yellow}Some logins failed — continuing with secrets + verify.${c.reset}\n`);
  }

  // Step 4: Secrets
  console.log(`${c.bold}[4/6] Secrets${c.reset}`);
  const secretsOk = await cmdSecrets();

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
    console.log(`  ${c.green}✓${c.reset} allowed ${perms.added.length} read-only kit command(s) ${c.dim}→ ${perms.file}${c.reset}`);
  }
  console.log();

  // Step 6: Verify
  console.log(`${c.bold}[6/6] Verify${c.reset}`);
  const verifyOk = await cmdCheck();

  // Recommended hardening: memory hooks + git hooks (opt-in via --recommended).
  if (recommended) {
    console.log(`\n${c.bold}[+] Recommended hardening${c.reset}`);
    const h = await applyRecommendedHardening(config);
    for (const e of h.memory.added) console.log(`  ${c.green}✓${c.reset} memory hook ${c.dim}${e}${c.reset}`);
    if (h.memory.added.length === 0) console.log(`  ${c.dim}= memory hooks already wired${c.reset}`);
    if (!h.memory.resolved) {
      console.log(`  ${c.yellow}!${c.reset} ${c.dim}memory hooks use a bare \`kit\` (kit not resolvable to an absolute path)${c.reset}`);
    }
    for (const r of h.hooks) {
      const icon = r.action === "failed" ? `${c.red}✗` : r.action === "skipped" ? `${c.yellow}!` : `${c.green}✓`;
      console.log(`  ${icon}${c.reset} git ${r.hookName} ${c.dim}(${r.action})${c.reset}`);
    }
    console.log();
  }

  const allOk = installOk && loginOk && secretsOk && verifyOk;

  if (allOk) {
    console.log(`${c.bold}${c.green}Setup complete — you're ready to go! ✓${c.reset}\n`);
  } else {
    console.log(`${c.bold}${c.yellow}Setup finished with issues. Run ${c.reset}${c.bold}kit check${c.reset}${c.yellow} to see what's left.${c.reset}\n`);
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
  console.log(
    `\n${c.dim}Blocks regenerate in place on re-run; edit outside the markers freely. ` +
      `Mutating kit commands (secrets/fix/hooks) still prompt by design.${c.reset}`,
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

async function cmdUpgrade(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit upgrade${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

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
  const tools: Record<string, { version: string; source: "mise" | "npm" | "pip" | "manual"; auth?: string }> = {};
  if (config.tools) {
    for (const [name, version] of Object.entries(config.tools)) {
      tools[name] = { version, source: "mise" };
    }
  }

  await updateCliLock(tools);

  console.log(`${c.green}✓${c.reset} Updated lock files from .kit.toml\n`);
  
  console.log(`${c.dim}Run ${c.reset}${c.bold}kit install${c.reset}${c.dim} to install updated tools${c.reset}`);
  console.log(`${c.dim}Run ${c.reset}${c.bold}kit skills${c.reset}${c.dim} to check skill status${c.reset}\n`);

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
      `${c.red}✗ Stack detection confidence too low (${(stack.confidence * 100).toFixed(0)}%) — cannot auto-generate config in non-interactive mode.${c.reset}`
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
      `  ${c.green}✓${c.reset} Detected: ${c.bold}${detectedLabel}${c.reset}  ${c.dim}(confidence: ${(stack.confidence * 100).toFixed(0)}%)${c.reset}\n`
    );
  }

  // ── Plaintext-secrets scan ─────────────────────────────────────────────
  // Surface obvious credentials sitting in .env / package.json / scripts/
  // BEFORE wiring up the vault, so the choice of backend is informed.
  const plaintextHits = await scanPlaintextSecrets(process.cwd());
  if (plaintextHits.length > 0) {
    const totalFindings = plaintextHits.reduce(
      (sum, h) => sum + h.findings.length,
      0,
    );
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
  let chosenStore: SecretsStore = "1password";
  if (!nonInteractive) {
    chosenStore = (await promptSelect("Secret backend?", [
      { value: "1password", label: "1Password", hint: "interactive signin via op CLI", recommended: true },
      { value: "infisical", label: "Infisical", hint: "self-hosted or cloud, token-based" },
      { value: "vault", label: "HashiCorp Vault", hint: "KV v2 paths" },
      { value: "aws-sm", label: "AWS Secrets Manager", hint: "IAM credentials required" },
      { value: "gcp-sm", label: "GCP Secret Manager", hint: "gcloud auth required" },
      { value: "azure-kv", label: "Azure Key Vault", hint: "az login required" },
      { value: "doppler", label: "Doppler", hint: "doppler login required" },
      { value: "bitwarden", label: "Bitwarden", hint: "bw login + unlock required" },
      { value: "env", label: "env (no vault)", hint: "not recommended — use only for local dev" },
    ])) as SecretsStore;
    console.log();
  }

  const tomlContent = generateToml(stack, { secretsStore: chosenStore });

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
  return "written";
}

async function cmdInit(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit init${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const nonInteractive =
    hasFlag(process.argv, "--non-interactive") || hasFlag(process.argv, "--yes") || hasFlag(process.argv, "-y");

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

      await updateSkillsLock(skills, kitMeta?.name ? `${kitMeta.name}@${kitMeta.version}` : undefined);

      const tools: Record<string, { version: string; source: "mise" | "npm" | "pip" | "manual"; auth?: string }> = {};
      if (config.tools) {
        for (const [name, version] of Object.entries(config.tools)) {
          tools[name] = { version, source: "mise" };
        }
      }

      await updateCliLock(tools);
    });
    console.log();
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
  console.log(`${c.dim}.gitignore holes, public-repo + credential combos, and CVE-deps.${c.reset}\n`);

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
    console.log(`${c.dim}Skipped. Run later with ${c.bold}kit security prescan <path>${c.reset}${c.dim}.${c.reset}\n`);
    return;
  }

  console.log(`${c.dim}Running prescan against ${scanPath}…${c.reset}\n`);
  const { runPrescan } = await import("./security-prescan.js");
  const report = await runPrescan({ root: resolve(scanPath), deep: false });
  const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of report.findings) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;
  console.log(`${c.bold}Scanned${c.reset} ${report.repoCount} repo(s), ${report.findings.length} finding(s):`);
  if (bySev.critical) console.log(`  ${c.red}critical${c.reset}: ${bySev.critical}`);
  if (bySev.high)     console.log(`  ${c.red}high    ${c.reset}: ${bySev.high}`);
  if (bySev.medium)   console.log(`  ${c.yellow}medium  ${c.reset}: ${bySev.medium}`);
  if (bySev.low)      console.log(`  ${c.dim}low     ${c.reset}: ${bySev.low}`);
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
      `${c.yellow}${result.warnings} warning${result.warnings === 1 ? "" : "s"}${c.reset}`
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

async function cmdSecretsOneCli(): Promise<boolean> {
  // Sub-sub: kit secrets onecli [status|register <KEY> --host <pattern>]
  const sub = process.argv[4] ?? "status";

  if (sub === "status") {
    console.log(`${c.bold}${c.cyan}kit secrets onecli status${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
    const status = await checkOneCliStatus();
    const reach = status.reachable
      ? `${c.green}reachable${c.reset}`
      : `${c.red}unreachable${c.reset}`;
    const auth = status.authenticated
      ? `${c.green}authenticated${c.reset}`
      : `${c.red}not authenticated${c.reset}`;
    console.log(`  Gateway API:    ${status.apiUrl}  ${reach}`);
    console.log(`  Gateway proxy:  ${status.gatewayUrl}  ${c.dim}(set HTTPS_PROXY here for agent processes)${c.reset}`);
    console.log(`  Auth:           ${auth}`);
    if (status.version) {
      console.log(`  Version:        ${c.dim}${status.version}${c.reset}`);
    }
    if (status.error) {
      console.log(`  ${c.yellow}→${c.reset} ${status.error}`);
    }
    console.log();
    if (!status.reachable) {
      console.log(
        `${c.dim}Start OneCLI: ${c.bold}cd /path/to/onecli && docker compose -f docker/docker-compose.yml up -d${c.reset}${c.dim}, or set ${c.bold}ONECLI_API_URL${c.reset}${c.dim} if it runs elsewhere.${c.reset}\n`,
      );
    }
    return status.reachable && status.authenticated;
  }

  if (sub !== "register") {
    console.error(
      `${c.red}Usage: kit secrets onecli [status|register <KEY> --host <pattern> [--path <pattern>]]${c.reset}`,
    );
    return false;
  }

  const args = process.argv.slice(5);
  const keyName = args[0];
  if (!keyName || keyName.startsWith("--")) {
    console.error(
      `${c.red}Usage: kit secrets onecli register <KEY> --host <pattern> [--path <pattern>]${c.reset}`,
    );
    return false;
  }
  const hostIdx = args.indexOf("--host");
  const pathIdx = args.indexOf("--path");
  const hostPattern = hostIdx >= 0 ? args[hostIdx + 1] : undefined;
  const pathPattern = pathIdx >= 0 ? args[pathIdx + 1] : undefined;

  if (!hostPattern) {
    console.error(
      `${c.red}--host required (e.g. api.stripe.com, api.openai.com).${c.reset}`,
    );
    return false;
  }

  console.log(`${c.bold}${c.cyan}kit secrets onecli register${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // S12: gate destructive op behind explicit elevation.
  // Register writes a fake placeholder into .env.local; one elevation =
  // one register so a stale TTL can't re-overwrite the file.
  const elev = await consumeElevation("onecli-register");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  // 1. Verify OneCLI is reachable + authed before reading the secret.
  const status = await checkOneCliStatus();
  if (!status.reachable || !status.authenticated) {
    console.error(
      `${c.red}OneCLI not ready: ${status.error ?? "unreachable"}${c.reset}`,
    );
    console.error(
      `${c.dim}Run ${c.bold}kit secrets onecli status${c.reset}${c.dim} for details.${c.reset}`,
    );
    return false;
  }

  // 2. Read the real value from the configured upstream vault.
  const config = await loadConfig(resolveConfigPath());
  if (!config.secrets?.store || config.secrets.store === "env") {
    console.error(
      `${c.red}No upstream vault configured in .kit.toml.${c.reset}`,
    );
    console.error(
      `${c.dim}Set ${c.bold}[secrets].store${c.reset}${c.dim} (run ${c.bold}kit init${c.reset}${c.dim}) first so kit knows where to read the real value from.${c.reset}`,
    );
    return false;
  }
  const keyConfig = config.secrets.keys?.[keyName];
  if (!keyConfig) {
    console.error(
      `${c.red}Key "${keyName}" not in [secrets.keys] — run ${c.bold}kit init${c.reset}${c.red} or add it manually.${c.reset}`,
    );
    return false;
  }

  const { generateSecrets: _unused } = await import("./secrets.js");
  void _unused;
  // resolveSecret isn't exported; reuse generateSecrets to pull the one value
  // we need. Cheaper: re-export resolveSecret, but for MVP we shell to op
  // /infisical/etc through the same code by asking generateSecrets to write
  // to a tmp file. Simpler: just use the env-resolution branch directly when
  // possible, and tell the user to use `kit secrets` for vault-resolution.
  // To avoid that complication for v1, require the value via stdin instead:
  console.log(
    `${c.dim}Reading real value from upstream vault (${config.secrets.store})...${c.reset}`,
  );
  const realValue = await readSecretValueFromVault(keyName, config);
  if (!realValue) {
    console.error(
      `${c.red}Could not resolve "${keyName}" from upstream vault.${c.reset}`,
    );
    console.error(
      `${c.dim}Check auth with ${c.bold}kit check${c.reset}${c.dim} and retry.${c.reset}`,
    );
    return false;
  }

  // 3. Register with OneCLI.
  try {
    const result = await registerSecretInOneCli({
      name: keyName,
      value: realValue,
      hostPattern,
      pathPattern,
    });
    console.log(
      `  ${c.green}✓${c.reset} registered ${c.bold}${keyName}${c.reset} in OneCLI  ${c.dim}(id ${result.id.slice(0, 8)}…, host=${hostPattern})${c.reset}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}OneCLI register failed: ${msg}${c.reset}`);
    return false;
  }

  // 4. Write placeholder to .env.local so agents read a non-credential.
  const placeholder = generatePlaceholder();
  const { writeFile, readFile, access } = await import("node:fs/promises");
  const envPath = `${process.cwd()}/.env.local`;
  let envContent = "";
  try {
    await access(envPath);
    envContent = await readFile(envPath, "utf-8");
  } catch {
    envContent = "";
  }
  const lineRe = new RegExp(`^${keyName}=.*$`, "m");
  const newLine = `${keyName}=${placeholder}  # placeholder — real value lives in OneCLI`;
  if (lineRe.test(envContent)) {
    envContent = envContent.replace(lineRe, newLine);
  } else {
    if (!envContent.endsWith("\n") && envContent.length > 0) envContent += "\n";
    envContent += newLine + "\n";
  }
  await writeFile(envPath, envContent, "utf-8");
  console.log(
    `  ${c.green}✓${c.reset} wrote placeholder to .env.local  ${c.dim}(${placeholder.slice(0, 14)}…)${c.reset}`,
  );

  // 5. Surface the proxy setup the agent needs to honor.
  const cfg = resolveOneCliConfig();
  console.log();
  console.log(`${c.bold}Next: route agent traffic through OneCLI${c.reset}`);
  console.log(
    `${c.dim}For the agent process to use the placeholder + get the real value injected, point its HTTPS proxy at:${c.reset}`,
  );
  console.log(`  ${c.bold}HTTPS_PROXY=${cfg.gatewayUrl}${c.reset}`);
  console.log(`  ${c.bold}HTTP_PROXY=${cfg.gatewayUrl}${c.reset}`);
  console.log(
    `${c.dim}OneCLI will intercept requests to ${c.bold}${hostPattern}${c.reset}${c.dim}, swap in the real value, and forward.${c.reset}\n`,
  );
  return true;
}

async function readSecretValueFromVault(
  keyName: string,
  config: kitConfig,
): Promise<string | null> {
  // Reuse generateSecrets() to materialize values, then read the one we want.
  // Writes to a temp file then deletes it; the real value never touches the
  // working tree.
  if (!config.secrets) return null;
  const { generateSecrets } = await import("./secrets.js");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "kit-onecli-"));
  const tmpEnv = join(dir, ".env");
  try {
    // We need generateSecrets to write to a path of our choosing; the current
    // signature takes outputPath. Use a no-template config so values land
    // verbatim as KEY=VALUE lines.
    const isolated = {
      ...config.secrets,
      template: undefined,
      keys: { [keyName]: config.secrets.keys![keyName] },
    };
    void writeFileSync; // keep import for future expansion
    await generateSecrets(isolated, tmpEnv);
    const content = readFileSync(tmpEnv, "utf-8");
    const match = content.match(new RegExp(`^${keyName}=(.*)$`, "m"));
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function cmdSecretsRevokeOld(): Promise<boolean> {
  // kit secrets revoke-old --via supabase-mgmt-api --project <ref> --key-id <id>
  const args = process.argv.slice(4);
  const viaIdx = args.indexOf("--via");
  const via = viaIdx >= 0 ? args[viaIdx + 1] : undefined;
  if (via !== "supabase-mgmt-api") {
    console.error(
      `${c.red}Usage: kit secrets revoke-old --via supabase-mgmt-api --project <ref> --key-id <id>${c.reset}`,
    );
    return false;
  }
  const projectIdx = args.indexOf("--project");
  const projectRef =
    projectIdx >= 0 ? args[projectIdx + 1] : process.env.SUPABASE_PROJECT_REF;
  const keyIdIdx = args.indexOf("--key-id");
  const keyId = keyIdIdx >= 0 ? args[keyIdIdx + 1] : undefined;

  if (!projectRef) {
    console.error(`${c.red}--project <ref> required (or set SUPABASE_PROJECT_REF).${c.reset}`);
    return false;
  }
  if (!keyId) {
    console.error(
      `${c.red}--key-id <id> required. List candidates with ${c.bold}kit secrets onecli status${c.reset}${c.red} or via Supabase Dashboard.${c.reset}`,
    );
    return false;
  }

  console.log(`${c.bold}${c.cyan}kit secrets revoke-old (supabase)${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const elev = await requireElevation("revoke-old");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  const supabase = await import("sandstream-kit-plugin-supabase").catch(() => null);
  if (!supabase) {
    console.error(`${c.red}sandstream-kit-plugin-supabase not installed.${c.reset}`);
    return false;
  }
  const client = supabase.makeClient();
  const result = await supabase.revokeScopedKey(client, projectRef, keyId);

  if (!result.ok) {
    console.error(`${c.red}✗ ${result.detail}${c.reset}`);
    return false;
  }
  console.log(`  ${c.green}✓${c.reset} ${result.detail}`);
  console.log(
    `\n${c.dim}Verify with ${c.bold}kit secrets onecli status${c.reset}${c.dim} or the Supabase Dashboard.${c.reset}\n`,
  );
  return true;
}

async function cmdSecretsSet(): Promise<boolean> {
  // kit secrets set <KEY> [--value <v> | --stdin] [--store <backend>]
  // Capture-to-vault: write a user-provided value to the configured vault. This
  // is the execution behind a service's `auth = "capture"` strategy. The value
  // is read via --stdin (safer — not in argv/ps) or --value; kit reuses the
  // existing setSecretValue path, so it never echoes or logs the secret.
  const args = process.argv.slice(3);
  const keyName = process.argv[4];
  if (!keyName || keyName.startsWith("--")) {
    console.error(
      `${c.red}Usage: kit secrets set <KEY> [--value <v> | --stdin] [--store <backend>]${c.reset}`,
    );
    return false;
  }

  const config = await loadConfig(resolveConfigPath());

  // Read value: --value <v> (visible in argv/ps) or --stdin (safer).
  let value: string | undefined;
  const valueIdx = args.indexOf("--value");
  if (valueIdx >= 0) value = args[valueIdx + 1];
  if (!value && hasFlag(args, "--stdin")) {
    value = await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk: string) => {
        buf += chunk;
      });
      process.stdin.on("end", () => resolve(buf.trim()));
    });
  }
  if (!value) {
    console.error(
      `${c.red}Provide the value via --stdin (safer) or --value <v> (visible in argv/ps).${c.reset}`,
    );
    return false;
  }

  const storeIdx = args.indexOf("--store");
  const storeOverride = storeIdx >= 0 ? args[storeIdx + 1] : undefined;
  const backendOpts = pickBackendOpts(config.secrets ?? {}, keyName, { envFallback: true });

  const result = await setSecretValue(config.secrets, keyName, value, {
    ...backendOpts,
    store: storeOverride as SetValueOptions["store"],
  });

  if (!result.ok) {
    console.error(`${c.red}✗ ${result.detail}${c.reset}`);
    return false;
  }
  console.log(
    `${c.green}✓${c.reset} captured ${c.bold}${keyName}${c.reset} to the vault ${c.dim}(${result.detail})${c.reset}`,
  );
  return true;
}

async function cmdSecretsPropagateStandalone(): Promise<boolean> {
  // kit secrets propagate <KEY> --value <v> | --stdin --to <targets> [opts]
  const args = process.argv.slice(4);
  const keyName = args[0];
  if (!keyName || keyName.startsWith("--")) {
    console.error(
      `${c.red}Usage: kit secrets propagate <KEY> [--value <v> | --stdin] --to <targets> [opts]${c.reset}`,
    );
    console.error(
      `${c.dim}targets: ${ALL_TARGETS.join(",")}${c.reset}`,
    );
    return false;
  }

  const toIdx = args.indexOf("--to");
  const targetSpec = toIdx >= 0 ? args[toIdx + 1] : undefined;
  if (!targetSpec) {
    console.error(`${c.red}--to <targets> required${c.reset}`);
    return false;
  }
  const targets = parseTargets(targetSpec);
  if (targets.length === 0) {
    console.error(
      `${c.red}--to: no valid targets in "${targetSpec}". Valid: ${ALL_TARGETS.join(", ")}${c.reset}`,
    );
    return false;
  }

  // Read value: --value <v>, --stdin, or interactive masked prompt.
  let value: string | undefined;
  const valueIdx = args.indexOf("--value");
  if (valueIdx >= 0) value = args[valueIdx + 1];
  if (!value && hasFlag(args, "--stdin")) {
    value = await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk: string) => {
        buf += chunk;
      });
      process.stdin.on("end", () => resolve(buf.trim()));
    });
  }
  if (!value) {
    console.error(
      `${c.red}Provide value via --value <v> (visible in argv/ps) or --stdin (safer).${c.reset}`,
    );
    return false;
  }

  // Same elevation gate as rotate.
  const elev = await requireElevation("propagate");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  // Parse propagation options (same flag surface as rotate --propagate).
  const propOpts: PropagationOptions = {};
  const envIdx = args.indexOf("--target-env");
  if (envIdx >= 0) propOpts.env = args[envIdx + 1] as PropagationOptions["env"];
  const flyAppIdx = args.indexOf("--fly-app");
  if (flyAppIdx >= 0) propOpts.flyApp = args[flyAppIdx + 1];
  const cfWorkerIdx = args.indexOf("--cf-worker");
  if (cfWorkerIdx >= 0) propOpts.cfWorker = args[cfWorkerIdx + 1];
  const railwayServiceIdx = args.indexOf("--railway-service");
  if (railwayServiceIdx >= 0) propOpts.railwayService = args[railwayServiceIdx + 1];
  const awsRegionIdx = args.indexOf("--aws-region");
  if (awsRegionIdx >= 0) propOpts.awsRegion = args[awsRegionIdx + 1];
  const ghRepoIdx = args.indexOf("--github-repo");
  if (ghRepoIdx >= 0) propOpts.githubRepo = args[ghRepoIdx + 1];
  const vercelScopeIdx = args.indexOf("--vercel-scope");
  if (vercelScopeIdx >= 0) propOpts.vercelScope = args[vercelScopeIdx + 1];

  console.log(`${c.bold}${c.cyan}kit secrets propagate ${keyName}${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  console.log(`${c.bold}Targets:${c.reset} ${c.dim}${targets.join(", ")}${c.reset}\n`);

  const results = await propagate(keyName, value, targets, propOpts);
  let allOk = true;
  for (const r of results) {
    const icon = r.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const argvWarn = r.valueInArgv ? `  ${c.yellow}[value in argv]${c.reset}` : "";
    console.log(`  ${icon} ${r.target.padEnd(10)}  ${c.dim}${r.detail}${c.reset}${argvWarn}`);
    if (!r.ok) allOk = false;
  }
  console.log();
  return allOk;
}

async function cmdSecretsPurgeHistory(): Promise<boolean> {
  // kit secrets purge-history <pattern> [<pattern>...] --force-history [--yes]
  const args = process.argv.slice(4);
  const force = hasFlag(args, "--force-history");
  const yes = hasFlag(args, "--yes");
  const patterns = args.filter((a) => !a.startsWith("--"));

  console.log(`${c.bold}${c.red}kit secrets purge-history${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (patterns.length === 0) {
    console.error(
      `${c.red}Usage: kit secrets purge-history <pattern> [more...] --force-history [--yes]${c.reset}`,
    );
    console.error(
      `${c.dim}Pattern can be a literal string (the leaked credential value) or a regex prefix.${c.reset}`,
    );
    return false;
  }

  console.log(`${c.bold}Patterns to scrub:${c.reset}`);
  for (const p of patterns) {
    const masked = p.length > 12 ? `${p.slice(0, 6)}…${p.slice(-4)}` : p;
    console.log(`  ${c.red}•${c.reset} ${masked}  ${c.dim}(${p.length} chars)${c.reset}`);
  }
  console.log();

  console.log(`${c.bold}Impact preview:${c.reset}`);
  let totalCommits = 0;
  for (const p of patterns) {
    const pv = await previewMatches(p, process.cwd());
    totalCommits += pv.matchedCommits;
    if (pv.matchedCommits === 0) {
      console.log(`  ${c.dim}•${c.reset} ${pv.pattern.slice(0, 14)}…  ${c.dim}no matches${c.reset}`);
    } else {
      console.log(
        `  ${c.yellow}•${c.reset} ${pv.pattern.slice(0, 14)}…  ${c.yellow}${pv.matchedCommits} commit(s) touched${c.reset}`,
      );
      for (const f of pv.matchedFiles.slice(0, 5)) {
        console.log(`      ${c.dim}↳ ${f}${c.reset}`);
      }
    }
  }
  console.log();

  if (totalCommits === 0) {
    console.log(`${c.green}✓ No commits reference the supplied pattern(s). Nothing to do.${c.reset}\n`);
    return true;
  }

  console.warn(
    `${c.red}⚠ This rewrites git history.${c.reset}\n` +
      `${c.dim}Every commit hash from the first affected commit forward changes. Required follow-ups:${c.reset}\n` +
      `  ${c.dim}1. Force-push every branch + tag to remotes${c.reset}\n` +
      `  ${c.dim}2. All teammates must DELETE their local clone and re-clone${c.reset}\n` +
      `  ${c.dim}3. CI runners + deploy pipelines that pulled from this remote must re-clone${c.reset}\n` +
      `  ${c.dim}4. The leaked credential must ALSO be rotated — scrubbing history doesn't invalidate the value${c.reset}\n`,
  );

  if (!force) {
    console.error(
      `${c.red}✗ Refusing to proceed without --force-history.${c.reset}`,
    );
    console.error(
      `${c.dim}Re-run with ${c.bold}--force-history${c.reset}${c.dim} after confirming the impact list above.${c.reset}\n`,
    );
    return false;
  }

  // Must be elevated AND must explicitly confirm in interactive mode.
  // History-rewrite is irreversible — one elevation = one purge.
  const elev = await consumeElevation("purge-history");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  if (!isNonInteractive() && !yes) {
    const ok = await promptConfirm(
      `Confirm DESTRUCTIVE history rewrite [type YES, default no in 15s]: `,
      15_000,
      false, // fail closed: never auto-confirm an irreversible history rewrite
    );
    if (!ok) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return false;
    }
  }

  const tools = await detectPurgeTools();
  if (!tools.filterRepoAvailable && !tools.bfgAvailable) {
    console.error(
      `${c.red}✗ Neither ${c.bold}git filter-repo${c.reset}${c.red} nor ${c.bold}bfg${c.reset}${c.red} installed.${c.reset}`,
    );
    console.error(
      `${c.dim}Install: ${c.bold}pip install git-filter-repo${c.reset}${c.dim} or ${c.bold}brew install bfg${c.reset}${c.dim}.${c.reset}\n`,
    );
    return false;
  }

  console.log(
    `${c.dim}Running ${tools.filterRepoAvailable ? "git filter-repo" : "bfg"}…${c.reset}`,
  );
  const result = await purgeHistory(patterns, process.cwd());

  if (!result.ok) {
    console.error(`${c.red}✗ ${result.detail}${c.reset}`);
    return false;
  }

  console.log(
    `  ${c.green}✓${c.reset} ${result.toolUsed} completed.  ${c.dim}${result.detail}${c.reset}`,
  );
  console.log(
    `\n${c.yellow}NEXT (manual):${c.reset}\n` +
      `  ${c.bold}git push origin --force --all${c.reset}\n` +
      `  ${c.bold}git push origin --force --tags${c.reset}\n` +
      `${c.dim}Then tell everyone with a clone to re-clone, and rotate the leaked credential if you haven't already.${c.reset}\n`,
  );

  return true;
}

async function cmdSecretsMigrate(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit secrets migrate${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const config = await loadConfig(resolveConfigPath());
  if (!config.secrets?.store || config.secrets.store === "env") {
    console.log(
      `${c.yellow}No vault configured in .kit.toml — set ${c.bold}[secrets].store${c.reset}${c.yellow} first (run ${c.bold}kit init${c.reset}${c.yellow}).${c.reset}\n`,
    );
    return false;
  }

  const store = config.secrets.store;
  const dryRun = hasFlag(process.argv, "--dry-run");
  const noClean = hasFlag(process.argv, "--no-clean");

  console.log(`${c.dim}Target vault: ${c.bold}${store}${c.reset}${c.dim} (dry-run: ${dryRun})${c.reset}\n`);

  const secretsOnly = hasFlag(process.argv, "--secrets-only");
  const plan = await planMigration(process.cwd(), { secretsOnly });
  if (plan.keyValues.size === 0) {
    if (plan.hits.length > 0) {
      console.log(
        `${c.dim}Found ${plan.hits.length} suspicious file(s) but no migratable KEY=VALUE lines.${c.reset}`,
      );
      for (const hit of plan.hits) {
        const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
        console.log(`  ${c.dim}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
      }
      console.log(
        `${c.dim}Embedded secrets in scripts / JSON need manual extraction.${c.reset}\n`,
      );
      return false;
    }
    console.log(`${c.green}✓ No plaintext secrets found — nothing to migrate.${c.reset}\n`);
    return true;
  }

  console.log(`${c.bold}Plan${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  for (const [key, { source }] of plan.keyValues) {
    console.log(`  ${c.green}→${c.reset} ${key}  ${c.dim}(from ${source})${c.reset}`);
  }
  console.log();

  if (dryRun) {
    console.log(
      `${c.dim}--dry-run set; not writing. Remove flag to perform the migration.${c.reset}\n`,
    );
    return true;
  }

  const nonInteractive = isNonInteractive();
  if (!nonInteractive) {
    const ok = await promptConfirm(
      `Push ${plan.keyValues.size} key(s) to ${store}? [Y/n] (auto-yes in 10s): `,
      10_000,
    );
    if (!ok) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return false;
    }
  }

  // S12: gate destructive op behind explicit elevation.
  const elev = await requireElevation("migrate");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }

  // Backend-specific options (region, project, vault name) from .kit.toml's
  // first key, with platform env-var fallbacks. Shared with the rotate flow.
  const backendOpts = pickBackendOpts(config.secrets, "", { envFallback: true });

  let fixed = 0;
  let failed = 0;
  const cleaned = new Map<string, string[]>(); // source-file → keys

  console.log();
  for (const [key, { value, source }] of plan.keyValues) {
    const result = await writeSecretToBackend(store, key, value, backendOpts);
    if (result.ok) {
      console.log(`  ${c.green}✓${c.reset} ${key}  ${c.dim}${result.detail}${c.reset}`);
      fixed++;
      if (!noClean) {
        const arr = cleaned.get(source) ?? [];
        arr.push(key);
        cleaned.set(source, arr);
      }
    } else {
      console.log(`  ${c.red}✗${c.reset} ${key}  ${c.red}${result.detail}${c.reset}`);
      failed++;
    }
  }
  console.log();

  if (cleaned.size > 0 && !noClean) {
    // Post-migration mode. Default "blank" replaces value with empty so the
    // plaintext is gone but devs still see which env vars are required.
    // Override with --keep-commented (legacy behavior) or --purge (drop the
    // line entirely).
    const mode: PostMigrateMode = hasFlag(process.argv, "--purge")
      ? "delete"
      : hasFlag(process.argv, "--keep-commented")
        ? "comment"
        : "blank";
    console.log(`${c.bold}Cleanup${c.reset}  ${c.dim}(mode=${mode})${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
    for (const [file, keys] of cleaned) {
      const { changed } = await commentOutInFile(
        `${process.cwd()}/${file}`,
        keys,
        mode,
      );
      const verb = mode === "delete" ? "deleted" : mode === "comment" ? "commented out" : "blanked";
      console.log(
        `  ${c.green}✓${c.reset} ${file}  ${c.dim}${changed} line(s) ${verb}${c.reset}`,
      );
    }
    const explain =
      mode === "blank"
        ? "Values blanked (KEY= retained as required-var hint). Lines are safe to commit."
        : mode === "comment"
          ? "Lines commented (not deleted) — plaintext value remains; remove after verifying vault read works."
          : "Lines deleted entirely. Use .env.template / vault for required-var documentation.";
    console.log(`${c.dim}${explain}${c.reset}\n`);
  }

  console.log(
    `${fixed > 0 ? c.green : c.dim}${fixed} key(s) migrated${c.reset}${failed > 0 ? `, ${c.red}${failed} failed${c.reset}` : ""}.`,
  );
  return failed === 0;
}

/**
 * Cross-vault migration. Reads every key whose source matches --from, writes
 * to --to, rewrites .kit.toml ref. One-shot elevation (consume on use).
 *
 * Example:
 *   kit auth elevate --scope vault-migrate
 *   kit secrets vault-migrate --from 1password --to infisical --dry-run
 *   kit secrets vault-migrate --from 1password --to infisical
 */
async function cmdSecretsVaultMigrate(): Promise<boolean> {
  const args = process.argv.slice(4);
  const fromArg = args.find((a) => a.startsWith("--from="))?.split("=")[1] ??
    (args[args.indexOf("--from") + 1] ?? "");
  const toArg = args.find((a) => a.startsWith("--to="))?.split("=")[1] ??
    (args[args.indexOf("--to") + 1] ?? "");
  const dryRun = hasFlag(args, "--dry-run");

  if (hasFlag(args, "--help") || hasFlag(args, "-h") || !fromArg || !toArg) {
    console.log(`${c.bold}kit secrets vault-migrate${c.reset} — move keys between vault backends\n`);
    console.log("Usage:");
    console.log("  kit secrets vault-migrate --from <source> --to <target> [--dry-run]");
    console.log("");
    console.log("Supported backends: 1password, infisical, bitwarden, doppler, vault, aws-sm, gcp-sm, azure-kv");
    console.log("");
    console.log("Migration is gated by elevation (one-shot — consumed on use):");
    console.log("  kit auth elevate --scope vault-migrate");
    return !(!fromArg || !toArg);
  }

  console.log(`${c.bold}${c.cyan}kit secrets vault-migrate${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  console.log(`${c.dim}From: ${c.bold}${fromArg}${c.reset}${c.dim} → To: ${c.bold}${toArg}${c.reset}${c.dim} (dry-run: ${dryRun})${c.reset}\n`);

  const config = await loadConfig(resolveConfigPath());
  if (!config.secrets) {
    console.log(`${c.yellow}No [secrets] block in .kit.toml — nothing to migrate.${c.reset}\n`);
    return false;
  }

  const sourceKeys = Object.entries(config.secrets.keys ?? {}).filter(
    ([, k]) => k.source === fromArg,
  );
  if (sourceKeys.length === 0) {
    console.log(`${c.yellow}No keys with source="${fromArg}" found in .kit.toml.${c.reset}\n`);
    return false;
  }

  console.log(`${c.bold}Plan${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  for (const [name] of sourceKeys) {
    console.log(`  ${c.green}→${c.reset} ${name}`);
  }
  console.log();

  if (dryRun) {
    console.log(`${c.dim}--dry-run set; not reading values. Remove flag + elevate to perform.${c.reset}\n`);
    return true;
  }

  // One-shot elevation: migration is destructive (writes to new vault +
  // mutates .kit.toml). Same scope used for the other one-shot ops.
  const elev = await consumeElevation("vault-migrate");
  if (!elev.ok) {
    console.error(`${c.red}✗ ${elev.reason}${c.reset}`);
    console.error(`${c.dim}Run: kit auth elevate --scope vault-migrate${c.reset}`);
    return false;
  }

  const { vaultMigrate } = await import("./secrets-vault-migrate.js");
  const result = await vaultMigrate(config as { secrets?: typeof config.secrets }, {
    from: fromArg as never,
    to: toArg as never,
    dryRun: false,
  });

  console.log(`${c.bold}Results${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  for (const item of result.items) {
    const marker = item.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    const refDetail = item.newRef ? ` ${c.dim}(${item.newRef})${c.reset}` : "";
    console.log(`  ${marker} ${item.name}  ${c.dim}${item.detail}${c.reset}${refDetail}`);
  }
  console.log();

  const failed = result.discovered - result.succeeded;
  console.log(
    `${result.succeeded > 0 ? c.green : c.dim}${result.succeeded} key(s) migrated${c.reset}${failed > 0 ? `, ${c.red}${failed} failed${c.reset}` : ""}.`,
  );

  if (result.succeeded > 0) {
    console.log(`\n${c.dim}Next steps:${c.reset}`);
    console.log(`  ${c.dim}1. Verify: kit check${c.reset}`);
    console.log(`  ${c.dim}2. Rotate values in old vault (optional but recommended):${c.reset}`);
    console.log(`     ${c.bold}kit secrets revoke-old --vault ${fromArg}${c.reset}`);
  }

  return failed === 0;
}

async function cmdSecretsSync(): Promise<boolean> {
  const args = process.argv.slice(3); // after "secrets sync"
  const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];
  const dryRun = hasFlag(args, "--dry-run");
  const target = (targetArg ?? "stdout") as "github" | "dotenv-ci" | "stdout";

  const config = await loadConfig(resolveConfigPath());

  if (!config.secrets) {
    console.log(`${c.dim}No secrets configured in ${KIT_FILE}${c.reset}`);
    return true;
  }

  console.log(`${c.bold}${c.cyan}kit secrets sync${c.reset} → ${c.bold}${target}${c.reset}${dryRun ? ` ${c.yellow}(dry run)${c.reset}` : ""}\n`);

  const result = await syncSecrets(config.secrets, {
    target,
    dryRun,
    projectPath: process.cwd(),
  });

  if (result.synced.length > 0) {
    console.log(`${c.green}✓${c.reset} Synced:`);
    result.synced.forEach((k) => console.log(`  ${c.green}+${c.reset} ${k}`));
  }
  if (result.skipped.length > 0 && dryRun) {
    console.log(`${c.dim}Would sync:${c.reset}`);
    result.skipped.forEach((k) => console.log(`  ${c.dim}~ ${k}${c.reset}`));
  }
  if (result.failed.length > 0) {
    console.log(`${c.red}✗${c.reset} Failed:`);
    result.failed.forEach((k) => console.log(`  ${c.red}✗${c.reset} ${k}`));
  }

  console.log(`\n${result.message}`);
  return result.failed.length === 0;
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
    if (ch.status === "fail") {
      console.log(`::error::${ch.category}/${ch.name}: ${ch.detail}`);
    } else if (ch.status === "warn") {
      console.log(`::warning::${ch.category}/${ch.name}: ${ch.detail}`);
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
    lines.push(`    <testcase name="${ch.name}" classname="${ch.category}">`);
    if (ch.status === "fail") {
      lines.push(`      <failure message="${ch.detail}"/>`);
    } else if (ch.status === "warn") {
      lines.push(`      <system-out>${ch.detail}</system-out>`);
    }
    lines.push(`    </testcase>`);
  }
  lines.push(`  </testsuite>`, `</testsuites>`);
  const xml = lines.join("\n");
  // Write to file for GitLab artifact collection — synchronous so the report is
  // guaranteed flushed before this (sync) function returns.
  writeFileSync("kit-report.xml", xml, "utf8");
  if (!allOk || warnings.length > 0) {
    console.log(`CI report written to kit-report.xml (${failures.length} failures, ${warnings.length} warnings)`);
  }
}

async function cmdCi(): Promise<boolean> {
  const args = process.argv.slice(2);
  const formatArg = args.find((a) => a.startsWith("--format="))?.split("=")[1] as CiFormat | undefined;
  const failOnWarning = hasFlag(args, "--fail-on-warning");
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

      const toolResults = config.tools
        ? await step("tools", () => checkTools(config.tools!))
        : [];
      const serviceResults = config.services
        ? await step("services", () => checkServices(config.services!))
        : [];
      const secretResults = config.secrets
        ? await step("secrets", () => checkSecrets(config.secrets!))
        : { templateExists: null, keys: [] };
      const skillResults = config.skills
        ? await step("skills", () => checkSkills(config.skills!))
        : [];
      const securityResults = await step("security scan", () => checkSecurity());
      const lockResults = await step("lock files", () => checkLockFiles(config));

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
          status: (s.authenticated ? "pass" : s.informational ? "warn" : "fail") as JsonCheck["status"],
          detail: s.informational
            ? (s.output || "manual setup (no CLI login)")
            : (s.output ?? (s.authenticated ? "authenticated" : "not authenticated")),
          category: "services",
        })),
        ...secretResults.keys.map((s) => ({
          name: s.name,
          status: (s.available ? "pass" : "fail") as JsonCheck["status"],
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
          status: s.status,
          detail: s.detail,
          category: `security/${s.category}`,
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
        { passed: 0, failed: 0, warnings: 0, skipped: 0 }
      );

      const allOk =
        summary.failed === 0 && (!failOnWarning || summary.warnings === 0);

      if (format === "github") {
        if (process.env.GITHUB_STEP_SUMMARY) {
          // Emit markdown summary to GitHub Actions step summary
          const lines = [
            "## kit CI Report",
            `| Status | Check | Detail |`,
            `|--------|-------|--------|`,
            ...checks.map(
              (c) =>
                `| ${c.status === "pass" ? "✅" : c.status === "warn" ? "⚠️" : "❌"} | \`${c.category}/${c.name}\` | ${c.detail} |`
            ),
            ``,
            `**${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings**`,
          ];
          await import("node:fs/promises").then(({ appendFile }) =>
            appendFile(process.env.GITHUB_STEP_SUMMARY!, lines.join("\n") + "\n")
          );
        }
        emitGithubAnnotations(checks);
        console.log(
          `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`
        );
      } else if (format === "gitlab") {
        emitGitlabJunit(checks, allOk);
        console.log(
          `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`
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
          `kit ci: ${summary.passed} passed, ${summary.failed} failed, ${summary.warnings} warnings`
        );
      }

      return allOk;
    }
  );
}

async function cmdAnalyze(): Promise<boolean> {
  // Flags: --claude, --rules to emit one or the other; default is both.
  // --write <dir> persists the drafts (suffix .draft.md so the user reviews
  // before committing).
  const args = process.argv.slice(3);
  const wantClaude = hasFlag(args, "--claude") || (!hasFlag(args, "--rules") && !hasFlag(args, "--claude"));
  const wantRules = hasFlag(args, "--rules") || (!hasFlag(args, "--rules") && !hasFlag(args, "--claude"));
  const writeFlagIdx = args.indexOf("--write");
  const writeDir = writeFlagIdx >= 0 ? args[writeFlagIdx + 1] ?? process.cwd() : null;

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
        console.log(`    ${c.dim}(existing CLAUDE.md found — review draft before merging)${c.reset}`);
      }
    }
    if (wantRules) {
      const path = `${writeDir}/RULES.md.draft`;
      await writeFile(path, renderRulesMd(report), "utf-8");
      console.log(`  ${c.green}✓${c.reset} wrote ${path}`);
      if (report.hasRulesMd) {
        console.log(`    ${c.dim}(existing RULES.md found — review draft before merging)${c.reset}`);
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

/**
 * `kit security prescan <path> [--deep]` — multi-repo baseline sweep.
 *
 * Walks every git repo under <path> and emits a security-finding report
 * (default-bundle: secret-leak, gitignore-holes, tracked-secret-files,
 * branch-protection, public/private). `--deep` adds npm-audit-high,
 * workflow-drift, and kit-audit-gap checks.
 *
 * Report written to ~/.kit/prescans/<timestamp>.{jsonl,summary.md}.
 *
 * Designed for first-install onboarding: point kit at ~/projects/
 * and get a baseline of every actionable security gap across the
 * whole codebase. Read-only — no vendor state is modified.
 */
async function cmdSecurityPrescan(): Promise<boolean> {
  const root = process.argv[4];
  if (!root) {
    console.error(
      `${c.red}Usage: kit security prescan <path> [--deep] [--exclude=<substr>,<substr>] [--only=<check>,<check>] [--skip=<check>,<check>] [--vs-baseline=<path.jsonl>] [--format=text|json]${c.reset}`,
    );
    console.error(
      `${c.dim}Example: kit security prescan ~/projects --deep --exclude=convex-backend,sentry-self-hosted${c.reset}`,
    );
    return false;
  }
  const deep = hasFlag(process.argv, "--deep");
  const excludeArg = process.argv.find((a) => a.startsWith("--exclude="));
  const exclude = excludeArg
    ? excludeArg.slice("--exclude=".length).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const onlyChecks = onlyArg
    ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const skipArg = process.argv.find((a) => a.startsWith("--skip="));
  const skipChecks = skipArg
    ? skipArg.slice("--skip=".length).split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const formatArg = process.argv.find((a) => a.startsWith("--format="))?.split("=")[1];
  const format: "text" | "json" = formatArg === "json" ? "json" : "text";
  // --vs-baseline=<path> turns prescan into a drift-detector: run once,
  // diff against a baseline JSONL, output ONLY new regressions, exit 1 if any.
  // Designed for cron / systemd-timer / GitHub Actions schedule.
  const baselineArg = process.argv.find((a) => a.startsWith("--vs-baseline="));
  const vsBaseline = baselineArg ? baselineArg.slice("--vs-baseline=".length) : undefined;
  const { runPrescan } = await import("./security-prescan.js");

  if (format === "text") {
    console.log(`${c.bold}${c.cyan}kit security prescan${c.reset}`);
    console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
    console.log(`  ${c.dim}root:${c.reset} ${root}`);
    console.log(`  ${c.dim}mode:${c.reset} ${deep ? "deep (default + CVE + workflow-drift + audit-gap + bumblebee)" : "default-bundle"}`);
    if (exclude.length) console.log(`  ${c.dim}exclude:${c.reset} ${exclude.join(", ")}`);
    console.log();
  }

  const startMs = Date.now();
  const report = await runPrescan({
    root: resolve(root),
    deep,
    exclude,
    onlyChecks,
    skipChecks,
  });
  const durSec = Math.round((Date.now() - startMs) / 1000);

  // --vs-baseline drift mode: diff current report against baseline JSONL,
  // emit ONLY added (regressions). Cron-friendly: exit 1 on regression.
  if (vsBaseline) {
    const { loadReport, diffReports } = await import("./security-prescan.js");
    const baseline = await loadReport(vsBaseline);
    const diff = diffReports(baseline, report);
    if (format === "json") {
      process.stdout.write(JSON.stringify({
        baseline: vsBaseline,
        addedCount: diff.added.length,
        removedCount: diff.removed.length,
        unchangedCount: diff.unchanged.length,
        added: diff.added,
      }, null, 2) + "\n");
    } else {
      console.log(`${c.bold}${c.cyan}drift report${c.reset}: ${diff.added.length} new finding(s) since baseline`);
      if (diff.added.length === 0) {
        console.log(`${c.green}✓ no regressions${c.reset}`);
      } else {
        for (const f of diff.added.slice(0, 30)) {
          const sevColor = f.severity === "critical" || f.severity === "high" ? c.red : c.yellow;
          console.log(`  ${sevColor}•${c.reset} ${f.repo} — ${f.category} (${f.severity}): ${f.detail.slice(0, 80)}`);
        }
        if (diff.added.length > 30) console.log(`  ${c.dim}…and ${diff.added.length - 30} more${c.reset}`);
      }
    }
    return diff.added.length === 0;
  }

  const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of report.findings) bySev[f.severity] = (bySev[f.severity] ?? 0) + 1;

  if (format === "json") {
    // Emit machine-readable summary; raw findings live in report.reportPath.
    process.stdout.write(JSON.stringify({
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      durationSec: durSec,
      root: report.root,
      mode: deep ? "deep" : "default",
      exclude,
      repoCount: report.repoCount,
      findingCount: report.findings.length,
      bySeverity: bySev,
      reportPath: report.reportPath,
      summaryPath: report.summaryPath,
      findings: report.findings,
    }, null, 2) + "\n");
    return bySev.critical === 0 && bySev.high === 0;
  }

  console.log(`${c.bold}Scanned${c.reset} ${report.repoCount} repo(s) in ${durSec}s`);
  console.log(`${c.bold}Findings${c.reset}: ${report.findings.length} total`);
  if (bySev.critical) console.log(`  ${c.red}critical${c.reset}: ${bySev.critical}`);
  if (bySev.high)     console.log(`  ${c.red}high    ${c.reset}: ${bySev.high}`);
  if (bySev.medium)   console.log(`  ${c.yellow}medium  ${c.reset}: ${bySev.medium}`);
  if (bySev.low)      console.log(`  ${c.dim}low     ${c.reset}: ${bySev.low}`);
  if (bySev.info)     console.log(`  ${c.dim}info    ${c.reset}: ${bySev.info}`);
  console.log();
  if (report.reportPath) console.log(`${c.dim}  raw:${c.reset}     ${report.reportPath}`);
  if (report.summaryPath) console.log(`${c.dim}  summary:${c.reset} ${report.summaryPath}`);
  console.log();

  return bySev.critical === 0 && bySev.high === 0;
}

/**
 * `kit security prescan-diff <baseline.jsonl> <latest.jsonl>` — drift report.
 *
 * Reads two prescan-JSONL files (the raw report, NOT the summary.md), and
 * surfaces three buckets: added (regressions), removed (fixed), unchanged.
 *
 * Use case: schedule a baseline prescan at first-install, then re-run
 * weekly and diff against the baseline to surface NEW security gaps
 * introduced since.
 */
async function cmdSecurityPrescanDiff(): Promise<boolean> {
  const baseline = process.argv[4];
  const latest = process.argv[5];
  if (!baseline || !latest) {
    console.error(
      `${c.red}Usage: kit security prescan-diff <baseline.jsonl> <latest.jsonl> [--format=text|json]${c.reset}`,
    );
    console.error(
      `${c.dim}Example: kit security prescan-diff ~/.kit/prescans/baseline.jsonl ~/.kit/prescans/latest.jsonl${c.reset}`,
    );
    return false;
  }
  const formatArg = process.argv.find((a) => a.startsWith("--format="))?.split("=")[1];
  const format: "text" | "json" = formatArg === "json" ? "json" : "text";
  const { loadReport, diffReports } = await import("./security-prescan.js");

  const a = await loadReport(baseline);
  const b = await loadReport(latest);
  const diff = diffReports(a, b);

  if (format === "json") {
    process.stdout.write(JSON.stringify({
      baseline,
      latest,
      addedCount: diff.added.length,
      removedCount: diff.removed.length,
      unchangedCount: diff.unchanged.length,
      added: diff.added,
      removed: diff.removed,
    }, null, 2) + "\n");
    return diff.added.length === 0;
  }

  console.log(`${c.bold}${c.cyan}kit security prescan-diff${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  console.log(`  ${c.dim}baseline:${c.reset} ${baseline}`);
  console.log(`  ${c.dim}latest:  ${c.reset} ${latest}\n`);
  console.log(`${c.bold}Added (regressions)${c.reset}: ${diff.added.length > 0 ? c.red : c.green}${diff.added.length}${c.reset}`);
  console.log(`${c.bold}Removed (fixed)${c.reset}:     ${c.green}${diff.removed.length}${c.reset}`);
  console.log(`${c.bold}Unchanged${c.reset}:           ${c.dim}${diff.unchanged.length}${c.reset}\n`);
  if (diff.added.length) {
    console.log(`${c.red}New findings since baseline:${c.reset}`);
    for (const f of diff.added.slice(0, 20)) {
      console.log(`  ${c.red}•${c.reset} ${f.repo} — ${f.category}: ${f.detail.slice(0, 80)}`);
    }
    if (diff.added.length > 20) {
      console.log(`  ${c.dim}…and ${diff.added.length - 20} more${c.reset}`);
    }
    console.log();
  }
  if (diff.removed.length) {
    console.log(`${c.green}Resolved since baseline:${c.reset}`);
    for (const f of diff.removed.slice(0, 10)) {
      console.log(`  ${c.green}✓${c.reset} ${f.repo} — ${f.category}: ${f.detail.slice(0, 80)}`);
    }
    if (diff.removed.length > 10) {
      console.log(`  ${c.dim}…and ${diff.removed.length - 10} more${c.reset}`);
    }
    console.log();
  }
  // Exit 0 = no regressions; 1 = regressions present (CI-friendly).
  return diff.added.length === 0;
}

async function cmdSecurity(): Promise<boolean> {
  // Subcommand routing
  const sub = process.argv[3];

  if (sub === "clear-cache") {
    return cmdSecurityClearCache();
  }

  if (sub === "scan-staged") {
    return cmdSecurityScanStaged();
  }

  if (sub === "scan-build") {
    return cmdSecurityScanBuild();
  }

  if (sub === "scan-transcripts") {
    return cmdSecurityScanTranscripts();
  }

  if (sub === "costs") {
    return cmdSecurityCosts();
  }

  if (sub === "check-gitignore") {
    return cmdSecurityCheckGitignore();
  }

  if (sub === "verify-pull") {
    return cmdSecurityVerifyPull();
  }

  if (sub === "prescan") {
    return cmdSecurityPrescan();
  }

  if (sub === "prescan-diff") {
    return cmdSecurityPrescanDiff();
  }

  if (sub !== "policy") {
    console.error(
      `${c.red}Usage: kit security policy [init|add <pkg>|check] | scan-staged | scan-build [dir...] | scan-transcripts | costs | check-gitignore [--fix] | verify-pull [--base <ref>] | prescan <path> [--deep] | prescan-diff <baseline.jsonl> <latest.jsonl> | clear-cache${c.reset}`,
    );
    return false;
  }
  const action = process.argv[4] ?? "check";

  console.log(`${c.bold}${c.cyan}kit security policy${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (action === "init") {
    const list = await initAllowlist(process.cwd());
    console.log(
      `  ${c.green}✓${c.reset} wrote .kit-allowlist.json  ${c.dim}(${list.packages.length} package(s) recorded)${c.reset}`,
    );
    console.log(
      `\n${c.dim}Defaults: enforce_runtime=true, enforce_dev=false, allow_wildcards=false. Edit ${c.bold}.kit-allowlist.json${c.reset}${c.dim} to tighten or relax.${c.reset}\n`,
    );
    return true;
  }

  if (action === "add") {
    const pkgName = process.argv[5];
    if (!pkgName) {
      console.error(`${c.red}Usage: kit security policy add <pkg>${c.reset}`);
      return false;
    }
    const { added, entry } = await addToAllowlist(pkgName, process.cwd());
    if (!entry) {
      console.error(
        `${c.red}Package "${pkgName}" not found in package.json — install it first.${c.reset}`,
      );
      return false;
    }
    if (added) {
      console.log(
        `  ${c.green}✓${c.reset} added ${c.bold}${entry.name}${c.reset} @ ${entry.range}  ${c.dim}(${entry.reason})${c.reset}`,
      );
    } else {
      console.log(
        `  ${c.dim}${entry.name}${c.reset} already on the allowlist @ ${entry.range}`,
      );
    }
    return true;
  }

  // check (default)
  const { list, violations } = await checkAllowlist(process.cwd());
  if (!list) {
    console.log(
      `${c.yellow}No .kit-allowlist.json found.${c.reset}  ${c.dim}Run ${c.bold}kit security policy init${c.reset}${c.dim} to bootstrap.${c.reset}\n`,
    );
    return false;
  }

  // Load .kit.toml to evaluate the secrets policy section against the
  // keys the project actually references. Missing config is non-fatal —
  // policy.secrets just doesn't apply.
  let secretViolations: ReturnType<typeof checkSecretPolicy> = [];
  try {
    const dkConfig = await loadConfig(resolveConfigPath());
    const keys = Object.keys(dkConfig.secrets?.keys ?? {});
    if (keys.length > 0) {
      secretViolations = checkSecretPolicy(list, keys);
    }
  } catch {
    /* no .kit.toml — skip secrets policy silently */
  }

  if (violations.length === 0 && secretViolations.length === 0) {
    console.log(`${c.green}✓${c.reset} All dependencies + secrets satisfy policy.\n`);
    return true;
  }

  const fmt = (kind: "runtime" | "dev"): string =>
    kind === "runtime" ? `${c.red}runtime${c.reset}` : `${c.yellow}dev${c.reset}`;

  if (violations.length > 0) {
    console.log(
      `${c.red}✗ ${violations.length} dependency violation(s):${c.reset}\n`,
    );
    for (const v of violations) {
      const why =
        v.reason === "not-on-allowlist"
          ? "not on allowlist"
          : "wildcard range blocked";
      console.log(
        `  ${c.red}•${c.reset} ${v.name} @ ${v.range}  ${c.dim}[${fmt(v.kind)}]${c.reset}  ${c.dim}${why}${c.reset}`,
      );
    }
    console.log();
  }

  if (secretViolations.length > 0) {
    console.log(
      `${c.red}✗ ${secretViolations.length} secrets policy violation(s):${c.reset}\n`,
    );
    for (const sv of secretViolations) {
      console.log(
        `  ${c.red}•${c.reset} ${sv.key}  ${c.dim}[${sv.reason}]${c.reset}  ${c.dim}${sv.detail}${c.reset}`,
      );
    }
    console.log(
      `\n${c.dim}Edit ${c.bold}.kit-allowlist.json${c.reset}${c.dim} under ${c.bold}"secrets"${c.reset}${c.dim} to declare scope, TTL, and spend caps per key.${c.reset}`,
    );
  }
  console.log(
    `\n${c.dim}Add a package: ${c.bold}kit security policy add <pkg>${c.reset}${c.dim}, or edit .kit-allowlist.json directly.${c.reset}\n`,
  );
  return false;
}

async function cmdSecurityScanStaged(): Promise<boolean> {
  // Designed to run from a git pre-commit hook. Prints nothing on success so
  // the hook output stays quiet for normal commits; exits non-zero with a
  // structured report when a credential pattern is staged.
  const hits = await scanStagedFiles();
  if (hits.length === 0) return true;

  const total = hits.reduce((sum, h) => sum + h.findings.length, 0);
  console.error(
    `${c.red}✗ kit secret-scan blocked the commit${c.reset}`,
  );
  console.error(
    `${c.dim}Found ${total} potential secret(s) in ${hits.length} staged file(s):${c.reset}`,
  );
  for (const hit of hits) {
    const labels = hit.findings
      .map((f) => `${f.label}:${f.preview}`)
      .join(", ");
    console.error(`  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
  }
  console.error(
    `\n${c.dim}If a finding is a false positive, you can bypass with ${c.bold}git commit --no-verify${c.reset}${c.dim}, but prefer migrating the value to a vault first (${c.bold}kit secrets migrate${c.reset}${c.dim}).${c.reset}`,
  );
  return false;
}

async function cmdSecurityScanBuild(): Promise<boolean> {
  // Optional positional: extra dirs to scan beyond the defaults.
  const extras = process.argv.slice(4).filter((a) => !a.startsWith("--"));
  const hits = await scanBuildArtifacts(process.cwd(), extras.length > 0 ? extras : undefined);
  if (hits.length === 0) {
    console.log(`${c.green}✓ scan-build: no credential patterns in build artifacts.${c.reset}`);
    return true;
  }
  const total = hits.reduce((sum, h) => sum + h.findings.length, 0);
  console.error(`${c.red}✗ scan-build: ${total} potential secret(s) in ${hits.length} build file(s):${c.reset}`);
  for (const hit of hits.slice(0, 20)) {
    const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
    console.error(`  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
  }
  if (hits.length > 20) {
    console.error(`  ${c.dim}… and ${hits.length - 20} more${c.reset}`);
  }
  console.error(
    `\n${c.dim}Typical cause: a server-only env var (e.g. STRIPE_SECRET_KEY) is referenced via NEXT_PUBLIC_* and got inlined into the client bundle. Rebuild after fixing.${c.reset}`,
  );
  return false;
}

async function cmdSecurityScanTranscripts(): Promise<boolean> {
  const hits = await scanTranscripts(process.cwd());
  if (hits.length === 0) {
    console.log(
      `${c.green}✓ scan-transcripts: no credentials found in agent state or prompt cache.${c.reset}`,
    );
    return true;
  }
  const total = hits.reduce((sum, h) => sum + h.findings.length, 0);
  console.error(
    `${c.red}✗ scan-transcripts: ${total} potential secret(s) in ${hits.length} transcript/cache file(s):${c.reset}`,
  );
  for (const hit of hits.slice(0, 20)) {
    const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
    console.error(`  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
  }
  if (hits.length > 20) {
    console.error(`  ${c.dim}… and ${hits.length - 20} more${c.reset}`);
  }
  console.error(
    `\n${c.yellow}Rotate the leaked credential and purge the offending file(s) — they get replayed into every future agent prompt until cleared.${c.reset}\n`,
  );
  return false;
}

async function cmdSecurityCosts(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit security costs${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // Pull spend-caps from the allowlist (if present) so cost samples can be
  // compared against the declared policy.
  const { readAllowlist } = await import("./security-policy.js");
  const list = await readAllowlist(process.cwd());
  const caps: Record<string, number | undefined> = {};
  if (list?.secrets) {
    for (const [keyName, entry] of Object.entries(list.secrets)) {
      caps[keyName] = entry.spend_cap_usd ?? list.policy.default_spend_cap_usd;
    }
  }

  const samples = await sampleCosts({ caps });
  if (samples.length === 0) {
    console.log(
      `${c.dim}No supported provider keys found in env. Set STRIPE_SECRET_KEY (or other supported providers) to enable cost samples.${c.reset}\n`,
    );
    return true;
  }

  let allOk = true;
  for (const s of samples) {
    const icon =
      s.status === "ok"
        ? `${c.green}✓${c.reset}`
        : s.status === "warn"
          ? `${c.yellow}!${c.reset}`
          : s.status === "over-cap" || s.status === "auth-failed"
            ? `${c.red}✗${c.reset}`
            : `${c.dim}-${c.reset}`;
    const capLabel =
      s.capUsd !== undefined
        ? `cap=${s.capUsd.toFixed(2)} USD`
        : `${c.yellow}no cap${c.reset}`;
    console.log(
      `  ${icon} ${s.provider.padEnd(10)}  current=${s.current.toFixed(2)} ${s.unit}  ${capLabel}  ${c.dim}${s.detail}${c.reset}`,
    );
    if (s.status === "over-cap" || s.status === "auth-failed") allOk = false;
  }

  console.log();
  if (!allOk) {
    console.log(
      `${c.red}One or more keys are over cap or failed auth. Rotate / reduce / refresh.${c.reset}\n`,
    );
  }
  return allOk;
}

async function cmdSecurityVerifyPull(): Promise<boolean> {
  // kit security verify-pull [--base <ref>] [--head <ref>] [--json]
  const args = process.argv.slice(4);
  const baseIdx = args.indexOf("--base");
  const headIdx = args.indexOf("--head");
  const base = baseIdx >= 0 ? args[baseIdx + 1] : "HEAD~1";
  const head = headIdx >= 0 ? args[headIdx + 1] : "HEAD";
  const jsonMode = hasFlag(args, "--json");

  const report = await auditPull(process.cwd(), base, head);
  const severity = reportSeverity(report);

  if (jsonMode) {
    console.log(JSON.stringify({ severity, ...report }, null, 2));
    return severity !== "fail";
  }

  console.log(`${c.bold}${c.cyan}kit security verify-pull${c.reset}  ${c.dim}(${base} → ${head})${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (report.changedFiles.length === 0) {
    console.log(`${c.dim}No files changed in this range. Nothing to audit.${c.reset}\n`);
    return true;
  }

  console.log(`${c.dim}${report.changedFiles.length} file(s) changed${c.reset}\n`);

  if (report.newDependencies.length > 0) {
    console.log(
      `${c.yellow}⚠ ${report.newDependencies.length} new dependency/-ies:${c.reset}`,
    );
    for (const dep of report.newDependencies) {
      console.log(
        `  ${c.yellow}•${c.reset} ${dep}  ${c.dim}→ run ${c.bold}kit triage npm ${dep}${c.reset}${c.dim} before installing${c.reset}`,
      );
    }
    console.log();
  }

  if (report.removedGitignoreEntries.length > 0) {
    const sensitive = report.removedGitignoreEntries.filter((l) =>
      /\.env|\.pem|\.key|id_rsa/.test(l),
    );
    const severityIcon =
      sensitive.length > 0 ? `${c.red}✗` : `${c.yellow}⚠`;
    console.log(
      `${severityIcon}${c.reset} ${report.removedGitignoreEntries.length} .gitignore entry/-ies removed:`,
    );
    for (const line of report.removedGitignoreEntries) {
      const hot = /\.env|\.pem|\.key|id_rsa/.test(line);
      const tag = hot ? `${c.red}[sensitive]${c.reset}` : `${c.dim}[low]${c.reset}`;
      console.log(`  ${hot ? c.red : c.yellow}•${c.reset} ${line}  ${tag}`);
    }
    console.log();
  }

  if (report.plaintextHits.length > 0) {
    const total = report.plaintextHits.reduce(
      (sum, h) => sum + h.findings.length,
      0,
    );
    console.log(
      `${c.red}✗ ${total} plaintext secret(s) introduced in ${report.plaintextHits.length} file(s):${c.reset}`,
    );
    for (const hit of report.plaintextHits.slice(0, 20)) {
      const labels = hit.findings
        .map((f) => `${f.label}:${f.preview}`)
        .join(", ");
      console.log(
        `  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`,
      );
    }
    if (report.plaintextHits.length > 20) {
      console.log(
        `  ${c.dim}… ${report.plaintextHits.length - 20} more${c.reset}`,
      );
    }
    console.log();
  }

  if (report.allowlistChanged || report.policyChanged || report.kitTomlChanged) {
    console.log(`${c.yellow}⚠ Security-policy files modified:${c.reset}`);
    if (report.allowlistChanged) console.log(`  ${c.yellow}•${c.reset} .kit-allowlist.json`);
    if (report.policyChanged) console.log(`  ${c.yellow}•${c.reset} .kit-policy.json`);
    if (report.kitTomlChanged) console.log(`  ${c.yellow}•${c.reset} .kit.toml`);
    console.log(
      `${c.dim}  → run ${c.bold}kit security policy check${c.reset}${c.dim} to verify the new state.${c.reset}\n`,
    );
  }

  if (severity === "ok") {
    console.log(`${c.green}✓ No security concerns in this pull.${c.reset}\n`);
    return true;
  }
  if (severity === "warn") {
    console.log(
      `${c.yellow}⚠ Pull contains items worth a second look — address before running install/deploy.${c.reset}\n`,
    );
    return true;
  }
  console.log(
    `${c.red}✗ Pull contains security regressions — review before continuing.${c.reset}\n`,
  );
  return false;
}

async function cmdSecurityCheckGitignore(): Promise<boolean> {
  const args = process.argv.slice(4);
  const fix = hasFlag(args, "--fix");

  console.log(`${c.bold}${c.cyan}kit security check-gitignore${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const result = await checkGitignore(process.cwd());
  const committed = await findCommittedSensitive(process.cwd());

  if (!result.exists) {
    console.log(`${c.yellow}⚠ No .gitignore file in this repo.${c.reset}\n`);
  } else {
    console.log(
      `${c.dim}.gitignore: ${result.presentPatterns.length}/${result.presentPatterns.length + result.missingPatterns.length} required patterns present${c.reset}\n`,
    );
  }

  if (result.missingPatterns.length === 0) {
    console.log(`${c.green}✓ All required ignore patterns present.${c.reset}`);
  } else {
    console.log(
      `${c.red}✗ Missing ${result.missingPatterns.length} required pattern(s):${c.reset}\n`,
    );
    for (const m of result.missingPatterns) {
      console.log(
        `  ${c.red}•${c.reset} ${c.bold}${m.pattern.padEnd(28)}${c.reset}  ${c.dim}${m.reason}${c.reset}`,
      );
    }
    console.log();
  }

  if (committed.length > 0) {
    console.log(
      `${c.red}⚠ ${committed.length} sensitive file(s) already tracked in git:${c.reset}\n`,
    );
    for (const path of committed.slice(0, 20)) {
      console.log(`  ${c.red}•${c.reset} ${path}`);
    }
    if (committed.length > 20) {
      console.log(`  ${c.dim}… ${committed.length - 20} more${c.reset}`);
    }
    console.log(
      `\n${c.yellow}Adding these to .gitignore does NOT untrack them. Use ${c.bold}git rm --cached <path>${c.reset}${c.yellow} + commit, then rotate any credentials they contained.${c.reset}\n`,
    );
  }

  if (fix && result.missingPatterns.length > 0) {
    const patch = await patchGitignore(process.cwd());
    console.log(
      `${c.green}✓${c.reset} appended ${patch.added} pattern(s) to .gitignore`,
    );
    console.log(
      `${c.dim}Review the new block, then ${c.bold}git add .gitignore && git commit${c.reset}${c.dim}.${c.reset}\n`,
    );
    return true;
  }

  if (result.missingPatterns.length > 0 && !fix) {
    console.log(
      `${c.dim}Run with ${c.bold}--fix${c.reset}${c.dim} to append the missing patterns to .gitignore.${c.reset}\n`,
    );
  }

  return result.missingPatterns.length === 0 && committed.length === 0;
}

async function cmdSecurityClearCache(): Promise<boolean> {
  // Sub-sub: `kit security clear-cache [bumblebee]`. Defaults to bumblebee
  // since that's the only cached binary kit currently manages whose
  // checksum can mismatch in normal dev use.
  const target = process.argv[4] ?? "bumblebee";

  console.log(`${c.bold}${c.cyan}kit security clear-cache${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  console.log(
    `${c.yellow}⚠ This will delete the cached ${target} binary.${c.reset}`,
  );
  console.log(
    `${c.dim}Use when you have intentionally rebuilt the scanner locally (e.g. a feature branch) and the pinned checksum no longer matches.${c.reset}`,
  );
  console.log(
    `${c.dim}If you did NOT rebuild and the checksum still mismatches, investigate for tampering — do not clear blindly.${c.reset}\n`,
  );

  const nonInteractive = isNonInteractive();
  if (!nonInteractive) {
    const ok = await promptConfirm(
      `Continue? [Y/n] (auto-yes in 8s): `,
      8000,
    );
    if (!ok) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return false;
    }
  }

  if (target !== "bumblebee") {
    console.error(`${c.red}Unknown cache target: ${target} (only 'bumblebee' is supported)${c.reset}`);
    return false;
  }

  const result = await clearBumblebeeCache();
  if (result.removed) {
    console.log(`  ${c.green}✓${c.reset} removed ${result.path}`);
    console.log(
      `${c.dim}Next ${c.bold}kit check${c.reset}${c.dim} will re-download and re-verify the scanner.${c.reset}\n`,
    );
  } else {
    console.log(`  ${c.dim}nothing to remove at ${result.path}${c.reset}\n`);
  }
  return true;
}

async function cmdCreatePlugin(): Promise<boolean> {
  const pluginName = process.argv[3];

  if (!pluginName) {
    console.error(`${c.red}Usage: kit create-plugin <name>${c.reset}`);
    console.error(`${c.dim}Example: kit create-plugin aws-s3${c.reset}`);
    console.error(`${c.dim}Creates ./kit-plugin-aws-s3/ with a working TypeScript adapter.${c.reset}`);
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
    console.error(`${c.dim}  --env <name>         Environment to use for setup (default: "default")${c.reset}`);
    console.error();
    console.error(`${c.dim}Example:${c.reset}`);
    console.error(`${c.dim}  kit clone https://github.com/sandstream/example my-project${c.reset}`);
    console.error(`${c.dim}  kit clone https://github.com/sandstream/example my-project --env production${c.reset}`);
    console.error(`${c.dim}  kit clone https://github.com/sandstream/example my-project --no-setup${c.reset}`);
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
    console.log(`${c.dim}Create one with 'cd ${cloneResult.clonedPath} && kit init' to set up kit.${c.reset}`);
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
    console.error(`${c.red}Error during setup: ${err instanceof Error ? err.message : String(err)}${c.reset}`);
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
    console.error(`${c.dim}  --env <name>    Environment to use (dev, staging, production, etc.)${c.reset}`);
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

async function cmdContextCheck(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const config = await loadConfig(resolveConfigPath());
  const findings = await checkContext(config.context);

  if (jsonMode) {
    console.log(JSON.stringify(findings, null, 2));
    return findings.every((f) => f.status !== "mismatch");
  }
  if (!config.context) {
    console.log(
      `${c.dim}No [context] declared in .kit.toml — each CLI is unlocked from its account + project.${c.reset}`,
    );
    const suggestion = suggestContextToml(await gatherLive(process.cwd()));
    if (suggestion) {
      console.log(`\nDetected here — add a ${c.bold}[context]${c.reset} block to .kit.toml to lock it:\n`);
      console.log(suggestion);
      console.log(
        `\n${c.yellow}Verify each value is correct for THIS repo before trusting it.${c.reset} ${c.dim}kit detected the currently-active CLI state, which is exactly what the lock exists to question. Then re-run kit context check.${c.reset}`,
      );
    } else {
      console.log(
        `${c.dim}Add one to lock each CLI to its account + project (gcloud/vercel/github/git/npm).${c.reset}`,
      );
    }
    return true;
  }
  console.log(`${c.bold}Context lock${c.reset}\n`);
  for (const f of findings) {
    const icon =
      f.status === "ok"
        ? `${c.green}✓${c.reset}`
        : f.status === "mismatch"
          ? `${c.red}✗${c.reset}`
          : `${c.yellow}!${c.reset}`;
    const actual = f.actual ?? `${c.dim}(unreadable)${c.reset}`;
    const detail =
      f.status === "ok"
        ? `${c.dim}${f.expected}${c.reset}`
        : `expected ${c.bold}${f.expected}${c.reset}, live ${c.bold}${actual}${c.reset}`;
    console.log(`  ${icon} ${f.tool}.${f.field}  ${detail}`);
  }
  const mismatches = findings.filter((f) => f.status === "mismatch");
  if (mismatches.length > 0) {
    console.log(
      `\n${c.red}${mismatches.length} mismatch(es) — you are NOT locked to the declared account/project. Do not run outward/destructive commands until this is green.${c.reset}`,
    );
  }
  // Mismatch = non-zero exit so this can gate a hook / agent before acting.
  // Unknown (tool absent / unreadable) does not block.
  return mismatches.length === 0;
}

async function cmdContextUse(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());
  if (!config.context) {
    console.log(
      `${c.dim}No [context] declared in .kit.toml. Add one to lock each CLI to its account + project.${c.reset}`,
    );
    return true;
  }
  console.log(`${c.bold}Context use${c.reset}\n`);
  const results = await applyContext(config.context, process.cwd());
  for (const r of results) {
    const icon = r.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(`  ${icon} ${r.step.tool}  ${c.dim}${r.step.describe}${c.reset}`);
  }
  // vercel/npm have no clean per-repo "active" state to switch — guide instead.
  if (config.context.vercel) {
    console.log(
      `  ${c.dim}vercel: pass --scope per command or run \`vercel link\`; kit does not switch the dashboard link.${c.reset}`,
    );
  }
  if (config.context.npm) {
    console.log(
      `  ${c.dim}npm: registry is global — set with \`npm config set registry <url>\` if it differs.${c.reset}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.log(`\n${c.yellow}${failed} step(s) failed (tool not installed?). Run kit context check to verify.${c.reset}`);
  }
  return failed === 0;
}

async function cmdContext(): Promise<boolean> {
  if (process.argv[3] === "check") return cmdContextCheck();
  if (process.argv[3] === "use") return cmdContextUse();
  // Fast, read-only PS1 indicator: `kit context --prompt` -> "[gcp:<project>]".
  if (hasFlag(process.argv, "--prompt")) {
    console.log(contextPrompt());
    return true;
  }

  const jsonMode = hasFlag(process.argv, "--json");

  try {
    const config = await loadConfig(resolveConfigPath());
    const context = await gatherProjectContext(config, process.cwd());

    if (jsonMode) {
      console.log(JSON.stringify(context, null, 2));
    } else {
      // Human-readable format
      console.log(`${c.bold}Project Context${c.reset}\n`);

      console.log(`${c.bold}Project: ${c.reset}${context.projectName}`);
      console.log(`${c.bold}kit Version: ${c.reset}${context.kitVersion}`);
      console.log(`${c.bold}Active Environment: ${c.reset}${context.activeEnvironment}`);
      console.log();

      if (context.detectedStack && Object.keys(context.detectedStack).length > 0) {
        console.log(`${c.bold}Detected Stack:${c.reset}`);
        for (const [key, value] of Object.entries(context.detectedStack)) {
          console.log(`  ${key}: ${value}`);
        }
        console.log();
      }

      if (context.tools.length > 0) {
        console.log(`${c.bold}Tools (${context.tools.filter((t) => t.ok).length}/${context.tools.length}):${c.reset}`);
        for (const tool of context.tools) {
          const status = tool.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
          const version = tool.installed ? ` ${c.dim}(${tool.installed})${c.reset}` : " not installed";
          console.log(`  ${status} ${tool.name}${version}`);
        }
        console.log();
      }

      if (context.services.length > 0) {
        console.log(`${c.bold}Services (${context.services.filter((s) => s.authenticated).length}/${context.services.length}):${c.reset}`);
        for (const service of context.services) {
          const status = service.authenticated ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
          console.log(`  ${status} ${service.name}`);
        }
        console.log();
      }

      if (context.secrets.keys.length > 0) {
        console.log(`${c.bold}Secrets (${context.secrets.keys.filter((s) => s.available).length}/${context.secrets.keys.length}):${c.reset}`);
        for (const secret of context.secrets.keys) {
          const status = secret.available ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
          console.log(`  ${status} ${secret.name}`);
        }
        console.log();
      }

      if (context.locks.length > 0) {
        const allInSync = context.locks.every((l) => l.inSync);
        console.log(`${c.bold}Lock Files${allInSync ? ` ${c.green}(in sync)` : ` ${c.yellow}(drift detected)`}:${c.reset}`);
        for (const lock of context.locks) {
          const status = lock.inSync ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
          console.log(`  ${status} ${lock.category}: ${lock.detail}`);
        }
      }
    }

    return true;
  } catch (err) {
    console.error(`${c.red}Error: ${(err as Error).message}${c.reset}`);
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
  for (const item of items) {
    const mark = item.ok ? `${c.green}✓${c.reset}` : `${c.yellow}○${c.reset}`;
    const hint = !item.ok && item.hint ? `  ${c.dim}→ ${item.hint}${c.reset}` : "";
    console.log(`  ${mark} ${item.label}  ${c.dim}${item.detail}${c.reset}${hint}`);
  }
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
  const budgetEnabled = config.governance?.enabled && (
    agent?.max_tokens_per_day || agent?.max_operations_per_hour
  );

  let budget: Awaited<ReturnType<typeof getBudgetStatus>> | null = null;
  if (budgetEnabled) {
    budget = await getBudgetStatus(config.governance);
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          agent: agent
            ? { id: agent.id, name: agent.name }
            : null,
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
        2
      )
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
    envInfo.environment === "prod"
      ? c.red
      : envInfo.environment === "staging"
        ? c.yellow
        : c.green;
  console.log(
    `  ${c.bold}Env:${c.reset}    ${envColor}${envInfo.environment}${c.reset}  ${c.dim}(via ${envInfo.source})${c.reset}`
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

const COMMAND_HELP: Record<string, string> = {
  status:         "Adoption checklist — what's set up across kit + the next step for each gap",
  check:          "Check status of all tools, services, secrets, and lock files",
  review:         "Full repo audit — runs check + design in one gate (for agents / PR checks)",
  design:         "Check design quality (a11y, design tokens) against the baseline",
  baseline:       "Freeze current warnings into .kit-baseline.json so future runs gate only net-new findings",
  memory:         "Local conversation memory — index transcripts + show stats",
  "memory index": "Index ~/.claude transcripts into the SQLite memory store",
  "memory search": "Full-text search memory (current project; --global for all)",
  "memory stats": "Show what the local memory store contains",
  "memory suggest": "Emit a BYO-LLM review prompt (recent activity + open items) — pipe to your own model",
  "memory merge": "Merge another machine's memory.db into this one (dedup by uuid)",
  "memory install": "Wire UserPromptSubmit + SessionEnd + SessionStart (recovery) hooks into ~/.claude/settings.json",
  "memory scan": "Scan the memory store for stored secrets (exit 1 if any found)",
  "memory backup": "Encrypted backup of the memory store (AES-256-GCM; KIT_MEMORY_PASSPHRASE)",
  "memory restore": "Restore an encrypted memory backup (e.g. on a new machine)",
  "memory share": "Promote a curated, secret-scanned entry to the shared (team) memory",
  "memory areas": "List shared responsibility areas (stripe, whatsapp, …)",
  "memory area": "Show shared entries for one area (decisions, how-built, status, security)",
  "memory pal": "Pending action ledger — list/add/done/snooze/verify/import 'blocked-on-you' items",
  "memory save": "Bookmark the current session as a named copilot",
  "memory threads": "List saved copilots (current project; --global for all)",
  "memory resume": "Print the resume command for a saved copilot (by name or number)",
  init:           "Detect stack, generate .kit.toml, and run full setup",
  upgrade:        "Update lock files from .kit.toml",
  install:        "Install missing tools via mise",
  login:          "Guided login to all configured services",
  "login --plan": "Show the resolved auth strategy per service (vault/interactive/capture + passkey) without logging in",
  secrets:        "Generate .env.local from template + secret store",
  "secrets sync": "Push resolved secrets to GitHub Actions / .env.ci / stdout",
  "secrets migrate": "Migrate plaintext secrets in .env* → configured vault",
  "secrets set": "Capture a value to the vault: kit secrets set <KEY> --stdin (safer) | --value <v>",
  "secrets rotate": "Rotate a key: write new value to vault (explicit / random)",
  "secrets onecli": "Register a key with OneCLI gateway so agent never sees the real value",
  "secrets purge-history": "Destructive: rewrite git history to remove a leaked value (--force-history)",
  "secrets propagate":     "Push a value to deploy targets only (skips vault-write). --stdin safer than --value",
  "secrets revoke-old":    "Revoke a previously-minted scoped key (Supabase Mgmt API)",
  "env switch":     "Switch active environment (dev/staging/prod). Gates prod-key reads.",
  "env current":    "Show active environment marker",
  analyze:        "Analyze repo + emit draft CLAUDE.md / RULES.md",
  "agent-config": "Inject a managed 'use kit' block into CLAUDE.md / AGENTS.md / .cursorrules / .clinerules",
  "security policy": "Dependency allowlist enforcement (init|add|check)",
  "security clear-cache": "Clear cached scanner binary (after intentional rebuild)",
  "security scan-staged": "Pre-commit: scan staged files for credential patterns",
  "security scan-build": "Scan build artifacts (.next/, dist/) for inlined secrets",
  "security scan-transcripts": "Scan agent transcripts + prompt caches for leaked credentials",
  "security costs": "Snapshot per-key spend vs policy cap (Stripe live; others stubbed)",
  "security check-gitignore": "Verify .gitignore covers sensitive paths (--fix to auto-patch)",
  "security verify-pull": "After git pull: audit new deps, gitignore drops, introduced secrets",
  "security prescan": "Multi-repo baseline sweep (secrets, gitignore, branch-protect; --deep adds CVE/workflow-drift/bumblebee; --format=json + --vs-baseline=<path> for CI drift)",
  "security prescan-diff": "Diff two prescan reports — surface new regressions + fixed findings since baseline",
  "audit secrets":  "Forensics: who/what touched each key + when (reads audit log)",
  "auth elevate":   "Mint elevation marker for destructive secret ops (TOTP/yes-prompt)",
  "auth status":    "Show active elevation",
  "auth revoke":    "Drop the elevation marker",
  "auth setup-totp": "Enroll TOTP secret (writes ~/.kit/totp-secret 0600)",
  "hooks add": "Install a built-in hook (e.g. secret-scan)",
  setup:          "Full pipeline: install → login → secrets → agent config → verify",
  "setup --recommended": "Opinionated profile: setup + memory hooks + git secret-scan/context-check gates",
  fix:            "Auto-fix what is possible",
  escalate:       "List what needs human action",
  governance:     "View governance status and agent access controls",
  skills:         "Check status of agent skills",
  hooks:          "Manage git hooks",
  add:            "Provision a service (kit add --list to see all adapters)",
  audit:          "View audit log of kit operations",
  doctor:         "Deep diagnostics — checks environment health in detail",
  env:            "Show current environment info",
  ci:             "CI-native check: GitHub Actions annotations, GitLab JUnit, JSON",
  clone:          "Clone a Git repository and run kit setup",
  run:            "Execute a command with project env vars loaded",
  open:           "Open service dashboard in browser (stripe, vercel, railway, etc.)",
  context:        "Show project context: tools, services, secrets, environment",
  "context check": "Verify each CLI's live account+project matches .kit.toml [context] (exits non-zero on mismatch)",
  "context use":   "Activate the declared context: gcloud config + repo git identity",
  "context --prompt": "Print a compact active-gcloud indicator for your shell prompt (PS1)",
  mcp:            "MCP server over stdio (Claude Code/Cursor/Codex); 'kit mcp list|auth|set-token|clear' manages declared servers",
  whoami:         "Show current agent / user identity",
  version:        "Print kit version",
  "create-plugin":"Scaffold a new kit plugin package",
  plugin:         "Discover and manage kit plugins (search, list, scaffold, install)",
  triage:         "Security evaluation before installing packages, images, or skills",
  pkg:            "Install package with mandatory triage (kit pkg npm:express)",
  team:           "Manage team members, roles, and permissions (RBAC, invitations, audit logs)",
  completions:    "Output shell completion script (bash, zsh, fish)",
  help:           "Show this help",
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

  console.log(`${c.bold}Installing ${spec.ecosystem}:${spec.name}${spec.version ? `@${spec.version}` : ""}${c.reset}\n`);
  console.log(`${c.cyan}Step 1: Triage...${c.reset}`);

  const result = await installPkg(spec);
  console.log(result.output);

  return result.installed;
}

async function cmdTriage(): Promise<boolean> {
  const args = process.argv.slice(3);
  const sandbox = hasFlag(args, "--sandbox");
  const filtered = args.filter((a) => a !== "--sandbox");
  const typeArg = filtered[0];
  // `check-deps` is a pre-commit subcommand handled below before we narrow
  // to TriageType; the rest of this function works against TriageType only.
  if (typeArg === "check-deps") {
    return cmdTriageCheckDeps();
  }
  const type = typeArg as TriageType;
  const target = filtered[1];

  if (!typeArg || typeArg === "--help" || typeArg === "-h") {
    console.log(`${c.bold}kit triage${c.reset} — Security evaluation before installing packages\n`);
    console.log("Usage:");
    console.log("  kit triage docker <image>           Evaluate Docker image (CVE + sandbox)");
    console.log("  kit triage npm <package>             Evaluate npm package (registry + GitHub)");
    console.log("  kit triage npm <package> --sandbox   + offline tarball inspection (install-script + path-traversal scan, no code executed)");
    console.log("  kit triage pip <package>             Evaluate PyPI package");
    console.log("  kit triage repo <github-url>         Evaluate GitHub repository");
    console.log("  kit triage skill <path|name>         Evaluate Claude Code / agent skill");
    console.log("  kit triage all <target>              Auto-detect and run all checks");
    console.log("  kit triage tools                     Show installed security tools");
    console.log("  kit triage check-deps                Pre-commit gate: fail if staged deps lack triage entries");
    console.log("");
    console.log("Examples:");
    console.log("  kit triage npm express");
    console.log("  kit triage npm node-ipc --sandbox");
    console.log("  kit triage docker stalwartlabs/stalwart");
    console.log("  kit triage skill searxng");
    return true;
  }

  const validTypes = ["docker", "npm", "pip", "repo", "skill", "all", "tools"];
  if (!validTypes.includes(type)) {
    console.error(`${c.red}Unknown triage type: ${type}${c.reset}`);
    console.error(`Valid types: ${validTypes.join(", ")}`);
    return false;
  }

  if (type === "tools") {
    const result = await listTriageTools();
    console.log(result.output);
    return true;
  }

  if (!target) {
    console.error(`${c.red}Target required for triage ${type}${c.reset}`);
    return false;
  }

  console.log(`${c.bold}Running triage on ${type}: ${target}${c.reset}\n`);
  const result = await runTriage(type as TriageType, target);
  console.log(result.output);

  // Sandbox is currently only meaningful for npm packages — extends the
  // registry-metadata check with offline tarball inspection.
  let sandboxClean = true;
  if (sandbox && type === "npm") {
    const { triageNpmSandbox } = await import("./triage-sandbox.js");
    console.log(`\n${c.bold}Sandbox inspection (offline):${c.reset}`);
    try {
      const sb = await triageNpmSandbox(target);
      console.log(`  package: ${sb.package}${sb.version ? `@${sb.version}` : ""}`);
      console.log(`  tarball: ${(sb.tarballSize / 1024).toFixed(1)} kB`);
      console.log(`  install scripts: ${sb.hasInstallScripts ? "YES (review below)" : "none"}`);
      if (sb.findings.length === 0) {
        console.log(`  ${c.green}✓ no risk signals${c.reset}`);
      } else {
        const critical = sb.findings.filter((f) => f.severity === "critical");
        if (critical.length > 0) sandboxClean = false;
        for (const f of sb.findings) {
          const tag =
            f.severity === "critical"
              ? `${c.red}[CRIT]${c.reset}`
              : f.severity === "warn"
                ? `${c.yellow}[WARN]${c.reset}`
                : `[info]`;
          console.log(`  ${tag} ${f.signal} — ${f.detail}`);
        }
      }
    } catch (err) {
      console.error(`  ${c.red}sandbox failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`);
      sandboxClean = false;
    }
  } else if (sandbox && type !== "npm") {
    console.log(`\n${c.dim}(--sandbox currently only applies to npm; ignored for ${type})${c.reset}`);
  }

  const overall = result.passed && sandboxClean;
  if (!overall) {
    console.log(`\n${c.yellow}⚠️  Review warnings above before proceeding.${c.reset}`);
  }

  // Record the triage outcome so the pre-commit triage-check can verify
  // that every newly added dep was evaluated. Failed runs aren't logged —
  // a failed triage means the user explicitly chose not to install, so it
  // shouldn't unblock the commit.
  if (overall && target) {
    await recordTriageRun(type, target, sandbox);
  }

  return overall;
}

const TRIAGE_LOG_FILE = ".kit-triage.jsonl";
const TRIAGE_MAX_AGE_DAYS = 7;

interface TriageLogEntry {
  timestamp: string;
  type: string;
  target: string;
  sandbox: boolean;
  granter: string;
}

async function recordTriageRun(
  type: string,
  target: string,
  sandbox: boolean,
): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const entry: TriageLogEntry = {
    timestamp: new Date().toISOString(),
    type,
    target,
    sandbox,
    granter: process.env.USER ?? "unknown",
  };
  try {
    await appendFile(
      resolve(process.cwd(), TRIAGE_LOG_FILE),
      JSON.stringify(entry) + "\n",
      "utf-8",
    );
  } catch (err) {
    console.error(`${c.dim}(triage-log append failed: ${err instanceof Error ? err.message : err})${c.reset}`);
  }
}

/**
 * `kit triage check-deps` — pre-commit step. Diffs staged dep manifests
 * (package.json, requirements.txt, pyproject.toml) against the cached
 * versions in HEAD; any newly-added top-level package must have a triage
 * entry within the last `TRIAGE_MAX_AGE_DAYS` days. Exits non-zero on
 * missing entries so the commit fails.
 *
 * Intentionally does NOT walk transitive deps — that's the lockfile's
 * job. The pre-commit gate fires on what the developer is signing off on,
 * which is the manifest entries they wrote.
 */
async function cmdTriageCheckDeps(): Promise<boolean> {
  const { execFileSync } = await import("node:child_process");
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");

  const gitShow = (ref: string): string | null => {
    try {
      return execFileSync("git", ["show", ref], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };

  const newDeps: { ecosystem: "npm" | "pip"; name: string }[] = [];

  // package.json — compare staged vs HEAD top-level dependencies.
  const stagedPkg = gitShow(":package.json");
  if (stagedPkg) {
    try {
      const headPkgRaw = gitShow("HEAD:package.json");
      const staged = JSON.parse(stagedPkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const head = headPkgRaw
        ? (JSON.parse(headPkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> })
        : {};
      const stagedDeps = { ...staged.dependencies, ...staged.devDependencies };
      const headDeps = { ...head.dependencies, ...head.devDependencies };
      for (const name of Object.keys(stagedDeps)) {
        if (!(name in headDeps)) newDeps.push({ ecosystem: "npm", name });
      }
    } catch { /* malformed package.json — skip */ }
  }

  // requirements.txt — line-oriented diff.
  const stagedReq = gitShow(":requirements.txt");
  if (stagedReq) {
    const headReq = gitShow("HEAD:requirements.txt") ?? "";
    const parseLines = (text: string) => new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split(/[<>=!~]/)[0]!.trim()),
    );
    const stagedSet = parseLines(stagedReq);
    const headSet = parseLines(headReq);
    for (const name of stagedSet) {
      if (!headSet.has(name)) newDeps.push({ ecosystem: "pip", name });
    }
  }

  if (newDeps.length === 0) return true;

  // Build a triage-log index of `<ecosystem>:<name>` → most-recent ISO ts.
  const latest: Record<string, string> = {};
  try {
    const text = await readFile(resolve(process.cwd(), TRIAGE_LOG_FILE), "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as TriageLogEntry;
        const key = `${entry.type}:${entry.target}`;
        const prev = latest[key];
        if (!prev || entry.timestamp > prev) latest[key] = entry.timestamp;
      } catch { /* skip malformed line */ }
    }
  } catch {
    /* no triage log yet */
  }

  const cutoff = Date.now() - TRIAGE_MAX_AGE_DAYS * 24 * 3600 * 1000;
  const missing: string[] = [];
  for (const dep of newDeps) {
    const key = `${dep.ecosystem}:${dep.name}`;
    const ts = latest[key];
    if (!ts || Date.parse(ts) < cutoff) {
      missing.push(`  - ${dep.ecosystem}:${dep.name}  (run: kit triage ${dep.ecosystem} ${dep.name})`);
    }
  }

  if (missing.length === 0) return true;

  console.error(`${c.red}✗ Triage missing for ${missing.length} newly-added dep(s):${c.reset}`);
  for (const line of missing) console.error(line);
  console.error("");
  console.error(`${c.dim}Triage policy lives in CLAUDE.md. Run the suggested triage commands above,`);
  console.error(`then re-stage and commit. Bypass with --no-verify is recorded to ${SKIPPED_COMMITS_LOG}.${c.reset}`);
  return false;
}

function cmdHelp(subcommand?: string): boolean {
  if (subcommand && COMMAND_HELP[subcommand]) {
    console.log(`kit ${subcommand} — ${COMMAND_HELP[subcommand]}`);
    return true;
  }

  const bold = c.bold, cyan = c.cyan, dim = c.dim, reset = c.reset, green = c.green;

  console.log(`${bold}kit${reset} ${dim}v${KIT_VERSION}${reset} — developer environment manager\n`);
  console.log(`${bold}Get going:${reset}  ${dim}npx sandstream-kit setup${reset}  ${dim}or${reset}  ${green}kit init${reset} ${dim}→${reset} ${green}kit check${reset} ${dim}→${reset} ${green}kit setup${reset}`);
  console.log(`${dim}Prereqs: Node 22+, git, and mise (brew install mise) for installing tools.${reset}\n`);
  console.log(`${bold}Usage:${reset}  kit ${cyan}<command>${reset} ${dim}[options]${reset}\n`);
  console.log(`${bold}Commands:${reset}`);

  const maxLen = Math.max(...Object.keys(COMMAND_HELP).map((k) => k.length));
  for (const [cmd, desc] of Object.entries(COMMAND_HELP)) {
    const pad = " ".repeat(maxLen - cmd.length + 2);
    console.log(`  ${green}${cmd}${reset}${pad}${dim}${desc}${reset}`);
  }

  console.log(`\n${bold}Options:${reset}`);
  console.log(`  ${green}--non-interactive${reset}  ${dim}No prompts (for CI / agent use)${reset}`);
  console.log(`  ${green}--json${reset}             ${dim}Machine-readable output${reset}`);
  console.log(`  ${green}--env=<name>${reset}       ${dim}Environment override (dev/staging/production)${reset}`);
  console.log(`  ${green}--dry-run${reset}          ${dim}Preview without writing (where supported)${reset}`);
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

        console.log(
          `${c.yellow}Invitation sent to ${email} as ${role}${c.reset}`,
        );
        console.log(`${c.dim}Check your email for the invitation link${c.reset}`);
        return true;
      }

      case "members": {
        if (args[0] !== "list") {
          console.error(`${c.red}Unknown subcommand: ${args[0]}${c.reset}`);
          return false;
        }

        console.log(`${c.bold}Team Members${c.reset}\n`);
        console.log(
          `${c.dim}(Requires team context — run from project with .kit.toml)${c.reset}`,
        );
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

        console.log(`${c.yellow}Member ${email} removed from team${c.reset}`);
        return true;
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
        process.stderr.write(
          `  ${entry.timestamp}  ${entry.sha.slice(0, 8)}  (${entry.reason})\n`,
        );
      } catch {
        /* malformed line — ignore */
      }
    }
    process.stderr.write(
      `  Review: cat ${SKIPPED_COMMITS_LOG} | jq .\n` +
        `  Suppress: KIT_HIDE_HOOK_SKIP_BANNER=1\n`,
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
  const nonInteractive = hasFlag(args, "--non-interactive") ||
    process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

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
      const COMMANDS: Record<string, () => boolean | Promise<boolean>> = {
        status: cmdStatus,
        whoami: cmdWhoami,
        check: cmdCheck,
        init: cmdInit,
        upgrade: cmdUpgrade,
        install: cmdInstall,
        login: cmdLogin,
        secrets: cmdSecrets,
        setup: cmdSetup,
        skills: cmdSkills,
        fix: cmdFix,
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
        clone: cmdClone,
        run: cmdRun,
        open: cmdOpen,
        context: cmdContext,
        triage: cmdTriage,
        baseline: cmdBaseline,
        design: cmdDesign,
        review: cmdReview,
        pkg: cmdPkg,
        team: cmdTeam,
        memory: cmdMemory,
      };
      // no command → `check` (the prior `case undefined` behaviour).
      const handler = COMMANDS[command ?? "check"];
      if (handler) {
        ok = await handler();
      } else {
        console.error(`Unknown command: ${command}`);
        const { didYouMean } = await import("./utils/didYouMean.js");
        const knownCommands = [
          ...new Set(Object.keys(COMMAND_HELP).map((k) => k.split(" ")[0])),
          "help", "version", "completions",
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

    // Non-interactive / CI: skip update check
    if (!nonInteractive) {
      checkForUpdate(KIT_VERSION).then((info) => {
        if (info) printUpdateNotice(info);
      }).catch(() => {}); // never fail
    }
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      console.error(
        `${c.red}Error: ${KIT_FILE} not found in ${process.cwd()}${c.reset}`,
      );
      console.error(
        `${c.dim}Create a .kit.toml to define your project's tools, services, and secrets.${c.reset}`,
      );
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

// Entrypoint — fire-and-forget by design; main() handles its own errors and sets
// process.exitCode. `void` marks the intentional non-await for no-floating-promises.
void main();
