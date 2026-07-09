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
import { cmdGateBash, cmdGateEnv } from "./commands/gate.js";
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
