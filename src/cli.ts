#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { hasFlag } from "./utils/flags.js";
import { generateCompletions } from "./completions.js";
import { checkForUpdate, printUpdateNotice } from "./update-check.js";
import { SKIPPED_COMMITS_LOG } from "./hooks.js";
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
import { cmdInsight } from "./commands/insight.js";
import { cmdProfile } from "./commands/profile.js";
import { cmdBroker } from "./commands/broker.js";
import { cmdBootstrap } from "./commands/bootstrap.js";
import { cmdSkill } from "./commands/skill.js";
import { cmdMap } from "./commands/repomap.js";
import {
  cmdStatus,
  cmdHealth,
  cmdIngest,
  cmdSupplyChain,
  cmdAgentAudit,
  cmdWhoami,
  cmdVersion,
} from "./commands/info.js";
import { cmdCreatePlugin, cmdClone, cmdRun, cmdOpen } from "./commands/project.js";
import { cmdHeal, cmdPkg } from "./commands/maintain.js";
import {
  cmdSkills,
  cmdEscalate,
  cmdAgentConfig,
  cmdGovernance,
  cmdStatusline,
  cmdTeam,
} from "./commands/agent.js";
import { cmdSelfAudit, cmdCoverage, cmdAnalyze } from "./commands/coverage.js";
import {
  cmdGateBash,
  cmdGateEnv,
  cmdGateEgress,
  cmdGateFs,
  runGateFailClosed,
} from "./commands/gate.js";
import { cmdCi } from "./commands/ci.js";
import { cmdSentinel } from "./commands/sentinel.js";
import { cmdStandards, cmdBaseline } from "./commands/standards.js";
import { cmdCheck } from "./commands/check.js";
import { cmdDesign } from "./commands/design.js";
import { cmdInstall } from "./commands/install.js";
import { cmdLogin } from "./commands/login.js";
import { cmdAuth } from "./commands/auth.js";
import { cmdAudit } from "./commands/audit.js";
import { cmdMcp } from "./commands/mcp.js";
import { cmdHooks } from "./commands/hooks.js";
import { cmdPlugin } from "./plugins-cli.js";
import { cmdTriage } from "./commands/triage.js";
import { cmdSlopsquat } from "./commands/slopsquat.js";
import { cmdMemory } from "./commands/memory.js";
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
        // PreToolUse gates must fail CLOSED: an internal fault has to DENY (exit 2), never fall
        // through to the generic catch below (exit 1 = non-blocking = the op would proceed).
        ok = GATE_VERBS.has(resolved)
          ? await runGateFailClosed(resolved, handler)
          : await handler();
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
    } else if (code === "KIT_INVALID_CONFIG" || code === "KIT_INVALID_PROFILE") {
      // A malformed .kit.toml OR .kit-profile.toml (bad TOML / failed schema validation) must
      // fail CLOSED like a missing one — a clean error + exit 1, never an uncaught stack trace
      // with empty --json stdout (a denial-of-verdict any dropped/edited file could cause). The
      // profile commands (show/check/freeze/sign/verify) all propagate InvalidProfileError here.
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
 * A single command's full surface descriptor: dispatch handler, stability tier,
 * and one-line help. COMMAND_REGISTRY below is the single source of truth for the
 * top-level command surface; COMMANDS / COMMAND_TIERS / COMMAND_HELP are DERIVED
 * from it (further down) so the three can never structurally drift. Sub-command
 * help (multi-word keys like "memory search") has no handler or tier of its own,
 * so it lives in SUBCOMMAND_HELP and is merged into COMMAND_HELP.
 */
export interface CommandDescriptor {
  handler: () => boolean | Promise<boolean>;
  stability: CommandTier;
  help: string;
  /**
   * When true, this verb is ALSO exposed as an MCP tool (named `kit_<verb>` with
   * `-` → `_`). The MCP server (mcp-server.ts) hand-registers each such tool with
   * its input schema, but which verbs are exposed is owned here — a drift test
   * (mcp-server.test.ts) asserts KIT_MCP_TOOLS matches this set, so "CLI = MCP"
   * is a provable invariant. mcp-server.ts can't import this registry (it would
   * cycle via commands/mcp.ts), hence the test-time cross-check rather than a
   * runtime derivation.
   */
  mcp?: boolean;
}

/** CLI verb → MCP tool name (`add` → `kit_add`, `supply-chain` → `kit_supply_chain`). */
export function mcpToolName(verb: string): string {
  return `kit_${verb.replace(/-/g, "_")}`;
}

/** The MCP tool names derived from every registry verb marked `mcp: true`, sorted.
 *  The mcp-server.test.ts drift guard asserts KIT_MCP_TOOLS equals this set. */
export function mcpExposedToolNames(): string[] {
  return Object.entries(COMMAND_REGISTRY)
    .filter(([, d]) => d.mcp)
    .map(([verb]) => mcpToolName(verb))
    .sort();
}

const COMMAND_REGISTRY: Record<string, CommandDescriptor> = {
  status: {
    handler: cmdStatus,
    stability: "stable",
    help: "Adoption checklist — what's set up across kit + the next step for each gap",
  },
  statusline: {
    handler: cmdStatusline,
    stability: "stable",
    help: "Compact one-line status (mode score · update · open PAL) for any agent's info bar — wire into Claude Code statusLine / a shell PS1",
  },
  whoami: { handler: cmdWhoami, stability: "stable", help: "Show current agent / user identity" },
  check: {
    handler: cmdCheck,
    stability: "stable",
    help: "Check status of all tools, services, secrets, and lock files",
    mcp: true,
  },
  health: {
    handler: cmdHealth,
    stability: "stable",
    help: "Deep environment health diagnostics — granular pass/fail across tools, services, config",
  },
  ingest: {
    handler: cmdIngest,
    stability: "stable",
    help: "Ingest external SARIF / OSV reports into kit's consolidated verdict (kit ingest <sarif|osv> <file>)",
  },
  "supply-chain": {
    handler: cmdSupplyChain,
    stability: "stable",
    help: "Install-time supply-chain triage: install-scripts, lockfile-drift, dep-confusion, slopsquat",
  },
  "agent-audit": {
    handler: cmdAgentAudit,
    stability: "stable",
    help: "Audit agent / MCP / hook configs for plaintext secrets + malware-shaped hooks",
  },
  sentinel: {
    handler: cmdSentinel,
    stability: "stable",
    help: "Autonomous redline watcher — propose/apply guarded remediations (run|install|status)",
  },
  scan: {
    handler: cmdScan,
    stability: "stable",
    help: "Run external scanners (snyk/trivy/grype/semgrep/osv) and merge them into one local verdict; --list-delegates shows the toggleable scanner library, [scan].delegates picks which run (--strict / [governance.scan] required_scanners gate non-running scanners)",
  },
  airgap: { handler: cmdAirgap, stability: "stable", help: "Air-gap posture tools (verify)" },
  "verify-provenance": {
    handler: cmdVerifyProvenance,
    stability: "stable",
    help: "Verify a release's SLSA provenance bundle offline (Ed25519 + SHA256 / cosign)",
  },
  "gha-audit": {
    handler: cmdGhaAudit,
    stability: "stable",
    help: "CI hardening lint — unpinned actions/images + pwn-request/remote-include (GitHub Actions, GitLab CI, Bitbucket Pipelines)",
  },
  sbom: {
    handler: cmdSbom,
    stability: "stable",
    help: "Generate a CycloneDX / SPDX SBOM from the lockfile (SARIF emit via kit scan --sarif)",
  },
  init: {
    handler: cmdInit,
    stability: "stable",
    help: "Detect stack, generate .kit.toml, and run full setup (--no-setup: config + lock files only)",
    mcp: true,
  },
  upgrade: { handler: cmdUpgrade, stability: "stable", help: "Update lock files from .kit.toml" },
  install: {
    handler: cmdInstall,
    stability: "stable",
    help: "Install missing tools via mise",
    mcp: true,
  },
  login: {
    handler: cmdLogin,
    stability: "stable",
    help: "Guided login to all configured services",
    mcp: true,
  },
  secrets: {
    handler: cmdSecrets,
    stability: "stable",
    help: "Generate .env.local from template + secret store",
    mcp: true,
  },
  setup: {
    handler: cmdSetup,
    stability: "stable",
    help: "Full pipeline: install → login → secrets → agent config → verify",
  },
  skills: { handler: cmdSkills, stability: "stable", help: "Check status of agent skills" },
  fix: { handler: cmdFix, stability: "stable", help: "Auto-fix what is possible", mcp: true },
  heal: {
    handler: cmdHeal,
    stability: "stable",
    help: "Loop: auto-fix safe findings, re-scan until green; gate destructive, fail-closed on tamper (--dry-run, --agent)",
  },
  escalate: { handler: cmdEscalate, stability: "stable", help: "List what needs human action" },
  governance: {
    handler: cmdGovernance,
    stability: "stable",
    help: "View governance status and agent access controls",
  },
  "agent-config": {
    handler: cmdAgentConfig,
    stability: "stable",
    help: "Inject a managed 'use kit' block into CLAUDE.md / AGENTS.md / .cursorrules / .clinerules / .github/copilot-instructions.md",
  },
  hooks: { handler: cmdHooks, stability: "stable", help: "Manage git hooks" },
  add: {
    handler: cmdAdd,
    stability: "stable",
    help: "Provision a service (kit add --list to see all adapters)",
    mcp: true,
  },
  audit: { handler: cmdAudit, stability: "stable", help: "View audit log of kit operations" },
  auth: {
    handler: cmdAuth,
    stability: "stable",
    help: "TOTP-gated elevation for destructive secret ops (elevate|status|revoke|setup-totp)",
  },
  mcp: {
    handler: cmdMcp,
    stability: "stable",
    help: "MCP server over stdio (Claude Code/Cursor/Codex); 'kit mcp list|auth|set-token|clear' manages declared servers",
  },
  env: { handler: cmdEnv, stability: "stable", help: "Show current environment info", mcp: true },
  doctor: {
    handler: cmdDoctor,
    stability: "stable",
    help: "Deep diagnostics — checks environment health in detail",
  },
  analyze: {
    handler: cmdAnalyze,
    stability: "stable",
    help: "Analyze repo + emit draft CLAUDE.md / RULES.md",
  },
  security: {
    handler: cmdSecurity,
    stability: "stable",
    help: "Security policy + scanners (policy | scan-staged | scan-build | verify-pull | prescan | …)",
  },
  "create-plugin": {
    handler: cmdCreatePlugin,
    stability: "stable",
    help: "Scaffold a new kit plugin package",
  },
  plugin: {
    handler: cmdPlugin,
    stability: "stable",
    help: "Discover and manage kit plugins (search, list, scaffold, install)",
  },
  ci: {
    handler: cmdCi,
    stability: "stable",
    help: "CI-native check: GitHub Actions annotations, GitLab JUnit, JSON (--init gitlab|bitbucket scaffolds a pipeline)",
    mcp: true,
  },
  "self-audit": {
    handler: cmdSelfAudit,
    stability: "stable",
    help: "Audit kit's own source against its 12 self-hardening rules (--list-rules, --only=<ids>, --format)",
  },
  coverage: {
    handler: cmdCoverage,
    stability: "experimental",
    help: "Evidence map: which standard's controls kit's deterministic checks auto-verify vs gap/manual/n-a — --standard=asvs|llm-top10|ssdf|agentic-top10|mcp-top10|all (default asvs); --list-standards to enumerate, [coverage].standards to toggle on/off (NOT a compliance attestation; --json for GRC tools)",
  },
  identity: {
    handler: cmdIdentity,
    stability: "experimental",
    help: "Manage this machine/agent's Ed25519 identity (init/show/rotate) — asymmetric, attributable signing for audit/policy (experimental)",
  },
  bootstrap: {
    handler: cmdBootstrap,
    stability: "experimental",
    help: "Cold-start an ephemeral environment in one command: setup → identity → policy pull → profile import → memory restore, from one platform-injected seed (fail-closed floor, fail-open fuel, --json receipt) (experimental)",
  },
  panic: {
    handler: cmdPanic,
    stability: "experimental",
    help: "Compromise response: rotate identity + emit a signed revocation + audit it + print the platform-revocation checklist (experimental)",
  },
  policy: {
    handler: cmdPolicy,
    stability: "experimental",
    help: "Signable org policy-as-code in .kit-policy.toml (init/show/validate/sign/verify/check/trust/pull/pull-revocations/approve) — identity-signed standard, org-distributable + enforced offline (experimental)",
  },
  clone: {
    handler: cmdClone,
    stability: "stable",
    help: "Clone a Git repository and run kit setup",
  },
  run: {
    handler: cmdRun,
    stability: "stable",
    help: "Execute a command with project env vars loaded",
    mcp: true,
  },
  open: {
    handler: cmdOpen,
    stability: "stable",
    help: "Open service dashboard in browser (stripe, vercel, railway, etc.)",
  },
  context: {
    handler: cmdContext,
    stability: "stable",
    help: "Show project context: tools, services, secrets, environment",
    mcp: true,
  },
  config: {
    handler: cmdConfig,
    stability: "stable",
    help: "Inspect + migrate the .kit.toml schema version",
  },
  triage: {
    handler: cmdTriage,
    stability: "stable",
    help: "Security evaluation before installing packages, images, or skills",
  },
  slopsquat: {
    handler: cmdSlopsquat,
    stability: "experimental",
    help: "Score npm/PyPI packages for hallucination/slopsquat risk (registry metadata)",
  },
  skill: {
    handler: cmdSkill,
    stability: "experimental",
    help: "Module-discipline linter for a SKILL.md: contract shape, trigger + sibling-collision, declared least-privilege scope, and CI regression drift — plus --runtime to audit recorded runs for scope-adherence + negative controls (from the transcript index, zero-LLM) (test <path> [--runtime] [--json] [--gate] [--update-snapshot]) — proves a skill is engineered like a module, NOT that its output is good (rubric grading is delegated) (experimental)",
  },
  baseline: {
    handler: cmdBaseline,
    stability: "stable",
    help: "Freeze current warnings into .kit-baseline.json so future runs gate only net-new findings",
  },
  design: {
    handler: cmdDesign,
    stability: "stable",
    help: "Check design quality (a11y, design tokens) against the baseline",
  },
  standards: {
    handler: cmdStandards,
    stability: "stable",
    help: "Dev-standards gate: general metrics + per-language linters + user plugins vs the baseline (--category general|specific|plugins|<lang>, --enforce fails CI)",
    mcp: true,
  },
  review: {
    handler: cmdReview,
    stability: "stable",
    help: "Full repo audit — runs check + design + standards in one gate (for agents / PR checks)",
  },
  insight: {
    handler: cmdInsight,
    stability: "experimental",
    help: "Deterministic lifecycle insight (unused: loaded-but-never-called MCP servers, from the transcript index; --json)",
  },
  map: {
    handler: cmdMap,
    stability: "experimental",
    help: "Deterministic repo-map: the relevant slice of files around a seed (import graph, --depth, --budget, --co-change, --json) — load part of a growing repo, not all of it (experimental)",
    mcp: true,
  },
  profile: {
    handler: cmdProfile,
    stability: "experimental",
    help: "Versioned, traveling project profile — declare {skills, mcp, workflows, plugins, vault, gates, scope}, audit declared-vs-discovered drift, sign the scope/RoE, and export/import a portable signed bundle to a fresh host (show|freeze|check|sign|verify|export|import; --json, --gate, --key, --out)",
  },
  broker: {
    handler: cmdBroker,
    stability: "experimental",
    help: "exec-broker runtime posture — graduate observe→enforce on evidence: enforce-readiness reports ready | would-block (+ what breaks) | untested; enforce does the guided, signed flip (refuses unless ready, --force overrides) (--json, --gate, --force)",
  },
  pkg: {
    handler: cmdPkg,
    stability: "stable",
    help: "Install package with mandatory triage (kit pkg npm:express)",
  },
  team: {
    handler: cmdTeam,
    stability: "experimental",
    help: "Manage team members, roles, and permissions (RBAC, invitations, audit logs)",
  },
  memory: {
    handler: cmdMemory,
    stability: "stable",
    help: "Local conversation memory — index transcripts + show stats",
  },
  "gate-bash": {
    handler: cmdGateBash,
    stability: "experimental",
    help: "PreToolUse install-gate: read an agent's pending Bash command on stdin, block (exit 2) un-triaged installs",
  },
  "gate-env": {
    handler: cmdGateEnv,
    stability: "experimental",
    help: "PreToolUse env-gate: read an agent's pending Write/Edit on stdin, block (exit 2) plaintext secrets aimed at .env* files",
  },
  "gate-egress": {
    handler: cmdGateEgress,
    stability: "experimental",
    help: "PreToolUse egress-gate (exec-broker): block (exit 2) Bash network targets outside the signed [scope].egress — fail-closed without a verified scope",
  },
  "gate-fs": {
    handler: cmdGateFs,
    stability: "experimental",
    help: "PreToolUse fs-gate (exec-broker): block (exit 2) Write/Edit outside the signed [scope].fs — fail-closed without a verified scope",
  },
};

// PreToolUse deny gates: an internal fault in one must DENY (exit 2), never fall through to the
// generic exit-1 path (non-blocking → the op would proceed). Dispatched via runGateFailClosed.
const GATE_VERBS = new Set(["gate-bash", "gate-env", "gate-egress", "gate-fs"]);

// Help for multi-word sub-commands (e.g. `kit memory search`). Help-only: no
// dispatch handler or stability tier of their own — merged into COMMAND_HELP below.
const SUBCOMMAND_HELP: Record<string, string> = {
  "check verify-attestation": "Verify a signed .kit-check-attestation.json receipt",
  "airgap verify":
    "Prove zero-egress: assert every scanner that would run air-gapped resolves to a local artifact (no cloud-only, no registry semgrep config)",
  "profile show": "Render the declared project profile with per-line reconciliation marks",
  "profile freeze":
    "Snapshot the discovered toolchain into .kit-profile.toml (preserves operator-authored workflows/plugins/scope/gates)",
  "profile check":
    "Report declared-vs-discovered drift (--gate fails CI on any drift; honest skip when no profile declared)",
  "profile sign":
    "Sign the profile (scope/RoE) into .kit-profile.sig via your identity/keystore — offline-verifiable",
  "profile verify":
    "Verify .kit-profile.sig offline (--key pin → local identity → org .kit-policy.signers)",
  "profile export":
    "Export a portable signed bundle (profile + signature + signer key) to --out or stdout",
  "profile import":
    "Import a portable bundle on a fresh host — integrity-verify offline, fail-closed on tamper/revoked (authoritative only once the signer is anchored)",
  "broker enforce-readiness":
    "Read the recorded observe window (.kit-audit.jsonl) and report whether it's safe to flip exec-broker to enforce: ready | would-block (+ exactly what breaks) | untested (--gate fails CI on any not-ready verdict)",
  "broker enforce":
    "Guided observe→enforce flip: readiness pre-flight (refuses unless ready; --force overrides), set [scope].enforce_runtime = true, re-sign the profile scope, and audit the transition",
  "memory index": "Index ~/.claude transcripts into the SQLite memory store",
  "memory search":
    "Full-text search memory (current project; --global for all; --fresh = recency-aware ranking)",
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
  "login --plan":
    "Show the resolved auth strategy per service (vault/interactive/capture + passkey) without logging in",
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
  "auth elevate": "Mint elevation marker for destructive secret ops (TOTP/yes-prompt)",
  "auth status": "Show active elevation",
  "auth revoke": "Drop the elevation marker",
  "auth setup-totp": "Enroll TOTP secret (writes ~/.kit/totp-secret 0600)",
  "hooks add": "Install a built-in hook (e.g. secret-scan)",
  "setup --recommended":
    "Opinionated profile: setup + memory hooks + git secret-scan/context-check gates",
  "context check":
    "Verify each CLI's live account+project matches .kit.toml [context] (exits non-zero on mismatch)",
  "context use": "Activate the declared context: gcloud config + repo git identity",
  "context --prompt": "Print a compact active-gcloud indicator for your shell prompt (PS1)",
  "config migrate":
    "Migrate .kit.toml to the current schema version (--dry-run inspect, --check CI gate, --force overwrite backup)",
  "config knobs": "List power-user env vars + .kit.toml fields kit honors (--json)",
  version: "Print kit version",
  completions: "Output shell completion script (bash, zsh, fish)",
  help: "Show this help",
};

// Derived surfaces — DO NOT hand-edit; add commands to COMMAND_REGISTRY above.
// Single source of truth for kit's top-level command surface; referenced by main()
// (which only runs as the entry) and imported by the coverage/surface tests.
export const COMMANDS: Record<string, () => boolean | Promise<boolean>> = Object.fromEntries(
  Object.entries(COMMAND_REGISTRY).map(([verb, d]) => [verb, d.handler]),
);

// Stability tier per top-level command, keyed identically to COMMANDS.
// command-surface.test.ts enforces 3-way parity; deriving it here makes that
// parity structural rather than a hand-maintained invariant.
export const COMMAND_TIERS: Record<string, CommandTier> = Object.fromEntries(
  Object.entries(COMMAND_REGISTRY).map(([verb, d]) => [verb, d.stability]),
);

// Top-level help (from the registry) plus help-only sub-command entries.
export const COMMAND_HELP: Record<string, string> = {
  ...Object.fromEntries(Object.entries(COMMAND_REGISTRY).map(([verb, d]) => [verb, d.help])),
  ...SUBCOMMAND_HELP,
};

/**
 * Stability tier for a top-level command. Part of kit's frozen command surface
 * (kit 2.x). See docs/CLI_STABILITY.md.
 *   stable       Covered by the 2.x compatibility promise; will not break.
 *   experimental Shipped but may change shape across minor versions.
 *   deprecated   Slated for removal in a future major; prints a runtime warning.
 */
export type CommandTier = "stable" | "experimental" | "deprecated";

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
