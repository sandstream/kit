#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { hasFlag, splitLeadingGlobalFlags, GLOBAL_FLAGS, readOnlyFlag } from "./utils/flags.js";
import { envTruthy } from "./utils/flags.js";
import { generateCompletions } from "./completions.js";
import { checkForUpdate, postCommandNoticesAllowed, printUpdateNotice } from "./update-check.js";
import { SKIPPED_COMMITS_LOG } from "./hooks.js";
import { cmdFix } from "./fix.js";
import { c } from "./utils/colors.js";
import { SUBCOMMAND_HELP } from "./subcommand-help.js";
import { didYouMean } from "./utils/didYouMean.js";
import { KIT_FILE, resolveConfigPath } from "./cli-shared.js";
import { reportUnexpectedCliError } from "./cli-error.js";
import { cmdEnv } from "./commands/env.js";
import { cmdContext } from "./commands/context.js";
import { cmdConfig } from "./commands/config.js";
import { cmdAirgap } from "./commands/airgap.js";
import { cmdScan } from "./commands/scan.js";
import { cmdVerifyProvenance } from "./commands/verify-provenance.js";
import { cmdGhaAudit } from "./commands/gha-audit.js";
import { cmdUpstream } from "./commands/upstream.js";
import { HELP_CATEGORIES as CATEGORIES } from "./help-categories.js";
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
import { cmdMonkeyTest } from "./commands/monkey-test.js";
import { cmdMap } from "./commands/repomap.js";
import { cmdBrowser } from "./commands/browser.js";
import { cmdUsage } from "./commands/usage.js";
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
  cmdTeam,
} from "./commands/agent.js";
import { cmdStatusline } from "./commands/statusline.js";
import { cmdSelfAudit, cmdCoverage, cmdAnalyze } from "./commands/coverage.js";
import { cmdAdr } from "./commands/adr.js";
import { cmdDecisions } from "./commands/decisions.js";
import {
  cmdGateBash,
  cmdGateEnv,
  cmdGateEgress,
  cmdGateFs,
  runGateFailClosed,
} from "./commands/gate.js";
import { cmdGuard, cmdGuardObserve } from "./commands/guard.js";
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
import { cmdTools } from "./commands/tools.js";
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

function printCommandHelp(args: readonly string[]): boolean {
  const target = args.join(" ");
  const entries = Object.entries(COMMAND_HELP);
  const match = entries
    .filter(([command]) => target === command || target.startsWith(`${command} `))
    .sort(([a], [b]) => b.length - a.length)[0];
  if (!match) return false;

  const [command, help] = match;
  console.log(`kit ${command} — ${help}`);
  const subcommands = entries.filter(([name]) => name.startsWith(`${command} `));
  if (subcommands.length > 0) {
    console.log("\nSubcommands:");
    for (const [name, description] of subcommands) {
      console.log(`  kit ${name} — ${description}`);
    }
  }
  return true;
}

/**
 * `kit help [<cmd> [<sub>]]` and `kit <cmd> [<sub>] --help`. A named command that does not exist is
 * an error (exit 1, with a did-you-mean), not the general help with exit 0: a typo'd help request
 * used to look like an answer.
 */
function runHelp(args: readonly string[]): number {
  // No target, or a flag first (`kit help --all`, `kit --help memory`): the general help.
  if (args.length === 0 || args[0]!.startsWith("-")) return cmdHelp(args) ? 0 : 1;
  // Matched as before, so flag-shaped entries (`setup --recommended`) still resolve.
  if (printCommandHelp(args)) return 0;
  console.error(`Unknown command: ${args[0]}`);
  const known = [...new Set(Object.keys(COMMAND_HELP).map((k) => k.split(" ")[0]!))];
  const suggestions = didYouMean(args[0]!, known);
  if (suggestions.length > 0) {
    console.error(`Did you mean: ${suggestions.map((s) => `'${s}'`).join(", ")}?`);
  }
  console.error(`Run 'kit help' for a list of available commands.`);
  return 1;
}

function cmdHelp(args: readonly string[] = []): boolean {
  if (printCommandHelp(args)) return true;

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

  // top-level keys have no space; subcommand keys ("memory index") do.
  const topLevel = Object.keys(COMMAND_HELP).filter((k) => !k.includes(" "));
  // Audience filter: harness commands are hook stdin protocols (gate-*,
  // statusline) — the agent harness invokes them; a human browsing help never
  // does, so by default they are noise. NEVER silently dropped: a counted note
  // below points at `kit help --all`, and `kit help <cmd>` always resolves them.
  const showAll = hasFlag(process.argv, "--all");
  const hidden = showAll ? [] : topLevel.filter((k) => COMMAND_AUDIENCE[k] === "harness");
  const hiddenSet = new Set(hidden);
  const shown = topLevel.filter((k) => !hiddenSet.has(k));
  const categorized = new Set(CATEGORIES.flatMap(([, cmds]) => cmds));
  const uncategorized = shown.filter((k) => !categorized.has(k));
  const groups: [string, string[]][] = uncategorized.length
    ? [...CATEGORIES, ["Other", uncategorized]]
    : CATEGORIES;

  const hasSub = (cmd: string) => Object.keys(COMMAND_HELP).some((k) => k.startsWith(`${cmd} `));
  const maxLen = Math.max(...topLevel.map((k) => k.length)) + 2; // room for the " +" marker

  console.log(
    `${bold}Commands:${reset}  ${dim}(+ = has subcommands; run \`kit <command> --help\`)${reset}`,
  );
  for (const [title, cmds] of groups) {
    const present = cmds.filter((cmd) => COMMAND_HELP[cmd] && !hiddenSet.has(cmd));
    if (!present.length) continue;
    console.log(`\n  ${dim}${title}${reset}`);
    for (const cmd of present) {
      const label = hasSub(cmd) ? `${cmd} +` : cmd;
      const pad = " ".repeat(maxLen - label.length + 2);
      console.log(`  ${green}${label}${reset}${pad}${dim}${COMMAND_HELP[cmd]}${reset}`);
    }
  }
  if (hidden.length > 0) {
    console.log(
      `\n  ${dim}(+ ${hidden.length} harness hook commands — invoked by the agent harness, not by you. See them with \`kit help --all\`.)${reset}`,
    );
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
 * we read it and print a red banner on stderr so the next `kit` invocation
 * makes the bypass visible. Suppressed when `KIT_HIDE_HOOK_SKIP_BANNER=1`
 * (useful for ephemeral CI).
 *
 * The log is append-only, so the count is the number of entries the repository
 * still recognises, not the number of lines: a squash-merge discards the commit
 * it recorded, and this banner used to report those forever. Entries that cannot
 * be checked stay counted — see `skipped-commits.ts` for that direction.
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
    const { parseSkippedCommits, partitionSkippedCommits, gitReachabilityProbe } =
      await import("./skipped-commits.js");
    const entries = parseSkippedCommits(content);
    if (entries.length === 0) return;
    const { live, orphaned, replayed } = partitionSkippedCommits(
      entries,
      gitReachabilityProbe(process.cwd()),
    );
    // Nothing the repo still contains, or nothing but replays — the log is history, not a finding.
    // A rebase replays commits without pre-commit (git runs post-commit for each), so a day of
    // rebasing used to produce a red banner about commits whose hook had run on the original.
    if (live.length === 0) return;
    process.stderr.write(
      `${c.red}[kit] ${live.length} commit(s) bypassed pre-commit hook — most recent:${c.reset}\n`,
    );
    for (const entry of live.slice(-3)) {
      process.stderr.write(`  ${entry.timestamp}  ${entry.sha.slice(0, 8)}  (${entry.reason})\n`);
    }
    if (replayed.length > 0) {
      // Named, not hidden: the operator should be able to see why the number is smaller than the
      // log is long, without opening the file.
      process.stderr.write(
        `  ${replayed.length} entr${replayed.length === 1 ? "y" : "ies"} came from a rebase/cherry-pick replay — not counted.\n`,
      );
    }
    if (orphaned.length > 0) {
      process.stderr.write(
        `  ${orphaned.length} earlier entr${orphaned.length === 1 ? "y is" : "ies are"} in no ref (squashed or amended) — not counted.\n`,
      );
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

export async function main(): Promise<void> {
  // Global flags may precede the command word (`kit --read-only check`, the form
  // README.md:299 and docs/THREAT_MODEL.md:98 document). Move them behind the
  // positionals — and rewrite process.argv to match — so command modules that
  // read subcommands off raw indices (`process.argv[3]`) see the same shape they
  // would for `kit check ...`. Without this the flag WAS the command and kit
  // answered "Unknown command: --read-only".
  const rawArgs = process.argv.slice(2);
  const { leading: leadingGlobals, rest: positional } = splitLeadingGlobalFlags(rawArgs);
  const args = leadingGlobals.length > 0 ? [...positional, ...leadingGlobals] : rawArgs;
  if (leadingGlobals.length > 0) {
    process.argv = [...process.argv.slice(0, 2), ...args];
  }
  const command = positional[0];
  // Help must precede policy/read-only initialization too: activating read-only
  // mode writes an audit event. Render only registry data, never dispatch a handler.
  if (command === "help" || hasFlag(args, "--help", "-h")) {
    process.exitCode = runHelp(command === "help" ? positional.slice(1) : positional);
    return;
  }
  const nonInteractive =
    hasFlag(args, "--non-interactive") ||
    process.env.CI === "true" ||
    process.env.GITHUB_ACTIONS === "true";

  // Activate read-only mode early so subsequent code paths see the env var.
  // Honored gates: writeSecretToBackend, grantElevation, installHooks, and
  // every kit-plugin write surface (vercel env-set, github secret-put,
  // stripe webhook-create, etc).
  const readOnly = readOnlyFlag(args);
  if (readOnly.kind === "invalid") {
    console.error(
      `${c.red}invalid value for ${readOnly.flag}: "${readOnly.value}" (expected no value, or a truthy value: 1, true, yes, on)${c.reset}`,
    );
    process.exitCode = 2;
    return;
  } else if (readOnly.kind === "active") {
    const { activateReadOnlyMode } = await import("./read-only-mode.js");
    activateReadOnlyMode("flag");
  } else if (envTruthy(process.env.KIT_READ_ONLY)) {
    const { activateReadOnlyMode } = await import("./read-only-mode.js");
    activateReadOnlyMode("env");
  }

  // Compute + export KIT_POLICY_HASH (policy identity, for classifiers / agents reading the env)
  // and KIT_POLICY_DENY (the resolved refusals, for the plugin packages). Also honors
  // `[policy].default_mode = "read-only"` as a third source for the
  // read-only gate above (after flag + env-var).
  try {
    const cfgForPolicy = await loadConfig(resolveConfigPath()).catch(() => null);
    if (cfgForPolicy?.policy) {
      // Both policy env vars in one call: the hash (which policy is in force) and the resolved deny
      // list the `kit-plugin-*` packages read, since they are standalone zero-dep packages kit-core
      // never calls and the environment is the only channel that reaches them. See `installPolicyEnv`.
      const { installPolicyEnv } = await import("./policy-gate.js");
      await installPolicyEnv(cfgForPolicy.policy);
      // Forces read-only regardless of KIT_READ_ONLY's value (a "0" must not defeat policy);
      // activateReadOnlyMode() itself no-ops when read-only is already active, so the only
      // way to skip it is for read-only to already be on (RO-2: this used to skip on any
      // KIT_READ_ONLY string, including "0" and "false").
      if (cfgForPolicy.policy.default_mode === "read-only") {
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

    // --version anywhere (it is global), before dispatch: `kit upgrade --version` must not upgrade.
    if (positional[0] === "-v" || hasFlag(args, "--version")) {
      ok = cmdVersion();
      process.exitCode = ok ? 0 : 1;
      return;
    }
    // version/completions need bespoke handling; everything else is a flat
    // command->fn dispatch (was a ~40-case switch — the main complexity driver).
    if (command === "version") {
      ok = cmdVersion();
    } else if (command === "completions") {
      const shell = positional[1];
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
        // READ-ONLY FLOOR. The 11 in-module guards are honest but were not exhaustive: a sweep
        // over the claim "read-only mode refuses every mutation" found `identity init` minting a
        // private key, `policy init` creating the policy doc, `check-gitignore --fix` rewriting
        // .gitignore and `upgrade` rewriting both lock files — all exit 0, none audited. The
        // defect was that nothing ENUMERATED the write surface, so refusing here, once, from a
        // declared table is what makes the claim checkable (see read-only-surface.ts).
        const { isReadOnlyMode } = await import("./read-only-mode.js");
        if (isReadOnlyMode()) {
          const { matchWriteSurface } = await import("./read-only-surface.js");
          const mutation = matchWriteSurface(process.argv);
          if (mutation) {
            const { refuseWrite } = await import("./read-only-mode.js");
            const refusal = await refuseWrite(mutation.operation, { command: resolved });
            console.error(`${c.red}✗ ${refusal.reason}${c.reset}`);
            process.exitCode = 1;
            return;
          }
        }
        // FLAG FLOOR. Two command modules validated their flags and 43 did not, and a flag that
        // silently does nothing is indistinguishable from a working one: `kit check --category
        // security` ran the FULL check for six majors, and `kit upgrade --self.` rewrote every
        // lock-file timestamp while installing nothing and printing success. Sweeping 43 handlers
        // would fix today and rot tomorrow — the defect is that nothing enumerated which flags a
        // command accepts, so this refuses once, here, from the declared table (flag-surface.ts),
        // exactly as the read-only floor above does for the write surface. A verb missing from the
        // table is UNVALIDATED, not unrestricted: it is skipped here and reported by self-audit.
        const { flagsForCommand } = await import("./flag-surface.js");
        const allowedFlags = flagsForCommand(resolved);
        if (allowedFlags !== null) {
          const { rejectUnknownFlags } = await import("./utils/flags.js");
          if (
            rejectUnknownFlags(`kit ${resolved}`, [...allowedFlags, ...GLOBAL_FLAGS], process.argv)
          ) {
            process.exitCode = 1;
            return;
          }
        }

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

    // Non-interactive / CI / --json / local-only commands: no update check.
    // See postCommandNoticesAllowed.
    if (postCommandNoticesAllowed(command, hasFlag(args, "--json"), nonInteractive)) {
      checkForUpdate(KIT_VERSION)
        .then((info) => {
          if (info) printUpdateNotice(info);
        })
        .catch(() => {}); // never fail

      // Pinned-scanner release notice. Same posture as the self-update check (shared
      // suppression, 3s timeout, cached, never throws) and deliberately NOT a verdict:
      // it only refreshes the cache the security check reads, and prints when a bump
      // exists. Never auto-installs — the binary pin is a supply-chain control.
      import("./bumblebee-update.js")
        .then(async ({ checkForBumblebeeUpdate, formatBumblebeeNotice }) => {
          const { BUMBLEBEE_VERSION } = await import("./bumblebee.js");
          const info = await checkForBumblebeeUpdate(BUMBLEBEE_VERSION);
          if (info) console.error(`  ${c.dim}╰─${c.reset} ${formatBumblebeeNotice(info)}`);
        })
        .catch(() => {}); // never fail
    }
  } catch (err: unknown) {
    const code =
      err instanceof Error && "code" in err ? (err as { code?: string }).code : undefined;
    const jsonMode = hasFlag(args, "--json");
    if (code === "KIT_USAGE_ERROR") {
      const message = err instanceof Error ? err.message : String(err);
      if (jsonMode) console.log(JSON.stringify({ ok: false, error: message }));
      console.error(`${c.red}${message}${c.reset}`);
      process.exitCode = 2;
    } else if (code === "ENOENT") {
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
      reportUnexpectedCliError(err, args);
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
    help: "Compact one-line status (mode score · update · open PAL) for Claude Code statusLine / a shell PS1; Codex gets it via SessionStart context",
  },
  whoami: { handler: cmdWhoami, stability: "stable", help: "Show current agent / user identity" },
  usage: {
    handler: cmdUsage,
    stability: "stable",
    // Not MCP-exposed: this is a boxed terminal view for a human, and every exposed tool costs
    // standing context in every agent session. The frozen ten stay ten.
    help: "Tabbed report of what kit has recorded — coverage with its denominator, refusals, memory, triage — plus --prove, which runs the floor against inputs it must refuse",
  },
  check: {
    handler: cmdCheck,
    stability: "stable",
    help: "Check status of tools, services, secrets, hooks, deploy env, security, tests, and lock files",
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
    help: "Audit agent, MCP, and hook configs for secrets, risky grants, and writes",
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
  upstream: {
    handler: cmdUpstream,
    stability: "experimental",
    help: "Latest versions and release notes of the services and the Node, PHP and Python runtimes this project uses (npm + GitHub): what upgrade or security release is due (kit upstream check [--json] [--enforce]; skipped in air gap)",
  },
  sbom: {
    handler: cmdSbom,
    stability: "stable",
    help: "Generate a CycloneDX / SPDX SBOM from the lockfile (SARIF emit via kit scan --sarif)",
  },
  init: {
    handler: cmdInit,
    stability: "stable",
    help: "Detect stack, generate .kit.toml, and run full setup (runs git init first when there is no repo; --no-setup: config + lock files only; offers ~/.kit/defaults.toml [init] known_services, --services a,b answers without a prompt)",
    mcp: true,
  },
  upgrade: { handler: cmdUpgrade, stability: "stable", help: "Update lock files from .kit.toml" },
  install: {
    handler: cmdInstall,
    stability: "stable",
    help: "Install missing tools via mise",
  },
  login: {
    handler: cmdLogin,
    stability: "stable",
    help: "Guided login to all configured services",
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
    help: "MCP server over stdio; 'kit mcp web' connects ChatGPT through an outbound secure tunnel",
  },
  env: { handler: cmdEnv, stability: "stable", help: "Show current environment info" },
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
    help: "Discover and manage kit plugins (search, list, scaffold, install, uninstall)",
  },
  ci: {
    handler: cmdCi,
    stability: "stable",
    help: "CI-native check: GitHub Actions annotations, GitLab JUnit, JSON (--init gitlab|bitbucket scaffolds a pipeline)",
  },
  "self-audit": {
    handler: cmdSelfAudit,
    stability: "stable",
    help: "Audit kit's own source against its 12 self-hardening rules (--list-rules, --only=<ids>, --format)",
  },
  coverage: {
    handler: cmdCoverage,
    stability: "experimental",
    help: "Evidence map: which standard's controls kit's deterministic checks auto-verify vs gap/manual/n-a — --standard=asvs|llm-top10|ssdf|agentic-top10|mcp-top10|aiuc-1|gcp-waf-security|all (default asvs); --list-standards to enumerate, [coverage].standards to toggle on/off (NOT a compliance attestation; --json for GRC tools)",
  },
  browser: {
    handler: cmdBrowser,
    stability: "experimental",
    help: "Browser-verification diagnostics: select Playwright/system Chrome/CDP strategy from [browser] without guessing (doctor|status|cdp-url|playwright-env; --json)",
  },
  "monkey-test": {
    handler: cmdMonkeyTest,
    stability: "experimental",
    help: "Role-based release gate for money-handling apps: detect stack/env/seed, scaffold Playwright desktop+mobile harness, run role crawl, sandbox money flow, and security pack (plan|init|run; --json)",
  },
  identity: {
    handler: cmdIdentity,
    stability: "experimental",
    help: "Manage this machine/agent's Ed25519 identity (init/show/rotate) — asymmetric, attributable signing for audit/policy (experimental)",
  },
  bootstrap: {
    handler: cmdBootstrap,
    stability: "experimental",
    help: "Cold-start an ephemeral environment: setup → identity → policy pull → profile import → memory restore (--policy-source <dir> or KIT_POLICY_SOURCE with an org anchor; --json receipt) (experimental)",
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
    // MCP-exposed: the install gate blocks untriaged packages and tells the agent
    // to run `kit triage` — in a shell-less client that instruction was previously
    // unfollowable. The enforcement layer must never demand an action the exposure
    // layer cannot perform.
    mcp: true,
  },
  tools: {
    handler: cmdTools,
    stability: "experimental",
    help: "Inventory the CLIs on this machine — path, installer, installed version, and (with --latest) how far behind each one is, and (with --auth) whether it is logged in",
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
  },
  review: {
    handler: cmdReview,
    stability: "stable",
    help: "Full repo audit: check + design + standards + adr + skill. --receipt writes signed PR evidence; verify-receipt checks its signature and head. --json emits a report; --stages and --category scope runs.",
    // MCP-exposed: THE one-shot audit for shell-less agents (kit_review),
    // superseding kit_standards on that surface (deprecated, leaves in 6.0).
    mcp: true,
  },
  decisions: {
    handler: cmdDecisions,
    stability: "experimental",
    help: "Decision ledger (the review surface when nobody reads the diff): 'kit decisions add' records a choice made where the spec was silent, 'list' shows them, 'verify' is the gate's verdict. kit requires the artifact and checks its SHAPE — never its content.",
  },
  adr: {
    handler: cmdAdr,
    stability: "experimental",
    help: "Enforce architecture decisions (ADR → gate): 'kit adr check' gates the repo on accepted ADRs' deterministic kit-enforce rules, cited to the ADR; 'kit adr list' shows enforced/documented; 'kit adr derive' proposes the decisions an inherited repo already obeys, each verified against the repo and emitted as status: proposed so it gates nothing until you accept it. Zero-LLM (prose is never interpreted).",
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
    // MCP-exposed (search only): cross-session recall is stateful — exactly the
    // case where an MCP tool earns its context cost for shell-less clients.
    mcp: true,
  },
  guard: {
    handler: cmdGuard,
    stability: "experimental",
    help: "Install gate for YOUR terminal (observe mode): PATH shims for npm/npx/brew/pip/bun/… log what the gate would decide — install | status | uninstall",
  },
  "guard-observe": {
    handler: cmdGuardObserve,
    stability: "experimental",
    help: "Shim protocol (invoked by ~/.kit/shims wrappers, not by you): record what the install gate would decide for a package-manager call",
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

/**
 * Who primarily invokes a command — the exposure-routing signal from the
 * agent-tool-context analysis (emitted as `x-kit-audience` in the OpenCLI
 * contract):
 *   - "human":   interactive / setup-time / operator actions. Never belongs on
 *                the MCP surface (a contract test enforces this, modulo the
 *                three deprecated tools that leave in 6.0).
 *   - "harness": hook stdin protocols (PreToolUse gates, statusline). Invoked
 *                by the agent harness itself — never *chosen* by a human or an
 *                agent, so they belong on no discovery surface at all.
 *   - "all":     the default — useful to humans, agents, and CI alike.
 * ("agent" is reserved for future agent-only verbs; nothing qualifies today —
 * every agent-loop command is also legitimate porcelain.)
 */
export type CommandAudience = "human" | "agent" | "harness" | "all";

const AUDIENCE_OVERRIDES: Record<string, CommandAudience> = {
  // Hook protocols — the harness pipes tool-call JSON on stdin.
  "gate-bash": "harness",
  "gate-egress": "harness",
  "gate-env": "harness",
  "gate-fs": "harness",
  // Invoked by the ~/.kit/shims wrappers — a protocol surface like the gates,
  // never chosen by a human or an agent.
  "guard-observe": "harness",
  statusline: "harness",
  // Interactive / setup-time / operator surfaces.
  add: "human",
  auth: "human",
  bootstrap: "human",
  broker: "human", // posture ops (observe→enforce flip) are operator decisions
  clone: "human",
  config: "human",
  "create-plugin": "human",
  doctor: "human",
  governance: "human",
  hooks: "human",
  identity: "human",
  insight: "human",
  install: "human",
  login: "human",
  mcp: "human", // configured into the harness by a human; agents never *run* it
  open: "human",
  panic: "human",
  pkg: "human",
  plugin: "human",
  profile: "human",
  setup: "human",
  skill: "human",
  skills: "human",
  status: "human",
  team: "human",
  upgrade: "human",
  whoami: "human",
  "agent-config": "human",
};

export const COMMAND_AUDIENCE: Record<string, CommandAudience> = Object.fromEntries(
  Object.keys(COMMAND_REGISTRY).map((verb) => [verb, AUDIENCE_OVERRIDES[verb] ?? "all"]),
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

// Run only as the real CLI entry; tests import COMMANDS and COMMAND_HELP.
function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntry()) void main().catch(reportUnexpectedCliError);
