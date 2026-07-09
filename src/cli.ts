#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { checkTools } from "./check-tools.js";
import { checkServices } from "./check-services.js";
import { checkSecrets } from "./check-secrets.js";
import { checkSecurity, type SecurityCheckResult } from "./check-security.js";
import { hasFlag, flagValue } from "./utils/flags.js";
import { analyzeRepo, renderClaudeMd, renderRulesMd } from "./analyze.js";
import { scanTranscripts } from "./scan-transcripts.js";
import { generateCompletions } from "./completions.js";
import { checkForUpdate, printUpdateNotice } from "./update-check.js";
import { checkSkills } from "./check-skills.js";
import { collectEscalations, formatEscalationMessage } from "./escalate.js";
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
import { cmdFix } from "./fix.js";
import { c } from "./utils/colors.js";
import { KIT_FILE, resolveConfigPath } from "./cli-shared.js";
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
import { cmdSbom } from "./commands/sbom.js";
import { cmdSecurity } from "./commands/security.js";
import { cmdSecrets } from "./commands/secrets.js";
import { cmdUpgrade } from "./commands/upgrade.js";
import { cmdDoctor, cmdAdd, cmdSetup, cmdInit } from "./commands/setup.js";
import { cmdReview } from "./commands/review.js";
import {
  cmdStatus,
  cmdHealth,
  cmdIngest,
  cmdSupplyChain,
  cmdAgentAudit,
  cmdWhoami,
  cmdVersion,
} from "./commands/info.js";
import { cmdCi } from "./commands/ci.js";
import { cmdSentinel } from "./commands/sentinel.js";
import { cmdStandards, cmdBaseline } from "./commands/standards.js";
import { cmdCheck } from "./commands/check.js";
import { cmdDesign } from "./commands/design.js";
import { cmdInstall } from "./commands/install.js";
import { cmdLogin } from "./commands/login.js";
import {
  type CiFormat,
  type JsonCheck,
  type JsonCheckOutput,
  detectCiFormat,
  emitGithubAnnotations,
  emitGitlabJunit,
} from "./cli-checks-shared.js";
import { cmdAuth } from "./commands/auth.js";
import { cmdAudit } from "./commands/audit.js";
import { cmdMcp } from "./commands/mcp.js";
import { cmdHooks } from "./commands/hooks.js";
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

// Re-exported for upgrade-self-error.test.ts, which imports these from "./cli.js".
// Implementations moved to commands/upgrade.ts in the 5.0-alpha cli.ts split.
export { isNpmPermissionError, npmPermissionRemediation } from "./commands/upgrade.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KIT_VERSION = (
  JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string }
).version;

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
