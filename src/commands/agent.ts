/**
 * Agent-facing + governance leaves, extracted from cli.ts (5.0-alpha god-module
 * split): `kit skills`, `escalate`, `agent-config`, `governance`, `statusline`,
 * `team`. Independent leaves (no cross-cluster cmd* calls), each returning a
 * boolean verdict for the COMMANDS dispatch table.
 */
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue, flagInt } from "../utils/flags.js";
import { loadConfig } from "../config.js";
import { KIT_FILE, resolveConfigPath } from "../cli-shared.js";
import { checkSkills } from "../check-skills.js";
import { checkTools } from "../check-tools.js";
import { checkServices } from "../check-services.js";
import { checkSecrets } from "../check-secrets.js";
import { collectEscalations, formatEscalationMessage } from "../escalate.js";
import { withGovernance } from "../governance-middleware.js";
import { mergeGovernanceConfigAsync, formatGovernanceStatus } from "../governance.js";
import { checkRevocationStatus } from "../revocation.js";
import { getBudgetStatus, formatBudgetStatus } from "../budget.js";
import {
  writeAgentConfig,
  detectAgentTargets,
  installKitPermissions,
  installCodexKitProfile,
  installAllInstallGates,
  installBrokerGates,
  installAiderRules,
  loadUserRulesProfile,
} from "../agent-config.js";

export async function cmdSkills(): Promise<boolean> {
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

export async function cmdEscalate(): Promise<boolean> {
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

export async function cmdAgentConfig(): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit agent-config${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const config = await loadConfig(resolveConfigPath()).catch(
    () => ({}) as Awaited<ReturnType<typeof loadConfig>>,
  );
  const userRules = await loadUserRulesProfile(config);
  let failed = false;
  if (userRules.error) {
    failed = true;
    console.log(`  ${c.red}✗${c.reset} user rules: ${userRules.error}`);
  }
  for (const warning of userRules.warnings) {
    console.log(`  ${c.yellow}!${c.reset} user rules: ${warning}`);
  }
  if (userRules.profile) {
    console.log(
      `  ${c.dim}· user rules loaded from ${userRules.profile.source} (${userRules.profile.lineCount} line(s), ${userRules.profile.byteCount} byte(s))${c.reset}`,
    );
  }

  const targets = detectAgentTargets();
  console.log(
    `${c.dim}Teaching ${targets.map((t) => `${c.reset}${c.bold}${t.agent}${c.reset}${c.dim}`).join(", ")} to use kit ` +
      `(managed block in their rules file).${c.reset}\n`,
  );

  const results = await writeAgentConfig(process.cwd(), targets, { userRules: userRules.profile });
  // Aider needs a bespoke installer (CONVENTIONS.md + a `read:` entry in
  // .aider.conf.yml — it auto-reads no rules file), so it's not an AGENT_TARGETS row.
  const aider = await installAiderRules(process.cwd(), userRules.profile);
  if (aider.detail !== "no Aider project detected") results.push(aider);
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
  // Codex does not expose Claude-style command allowlists. Install a personal
  // profile instead: low-friction workspace automation without committing a risk
  // preference to the repo.
  const codexProfile = await installCodexKitProfile();
  if (codexProfile.action === "created" || codexProfile.action === "updated") {
    console.log(
      `\n  ${c.green}✓${c.reset} installed Codex personal profile ${c.dim}${codexProfile.file}${c.reset} ${c.dim}(use: ${c.reset}${c.bold}codex --profile ${codexProfile.profile}${c.reset}${c.dim})${c.reset}`,
    );
  } else if (codexProfile.action === "unchanged") {
    console.log(
      `\n  ${c.dim}= Codex personal profile already current (${codexProfile.file}; use: codex --profile ${codexProfile.profile})${c.reset}`,
    );
  } else if (codexProfile.action === "skipped") {
    console.log(
      `\n  ${c.dim}· Codex personal profile skipped: ${codexProfile.detail ?? codexProfile.action}${c.reset}`,
    );
  } else if (codexProfile.action === "failed") {
    console.log(
      `\n  ${c.yellow}!${c.reset} could not update Codex personal profile ${codexProfile.file}: ${codexProfile.detail}`,
    );
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
  // Opt-in: the exec-broker gates (Pillar 3). NOT default — a wired egress-gate is fail-closed
  // (no verified [scope] ⇒ deny all network), so it's only wanted once the operator has declared
  // + signed a scope/RoE. `--broker-gate` is that deliberate opt-in.
  if (hasFlag(process.argv, "--broker-gate")) {
    console.log(
      `\n  ${c.bold}exec-broker gates${c.reset} ${c.dim}(block network/writes outside the signed [scope]/RoE; fail-closed — declare + sign a scope first with ${c.reset}${c.bold}kit profile sign${c.reset}${c.dim}):${c.reset}`,
    );
    const r = await installBrokerGates();
    if (r.action === "created" || r.action === "updated") {
      console.log(
        `    ${c.green}✓${c.reset} Claude Code ${c.dim}→ ${r.file} (gate-egress + gate-fs)${c.reset}`,
      );
    } else if (r.action === "unchanged") {
      console.log(`    ${c.dim}= Claude Code already wired (${r.file})${c.reset}`);
    } else {
      console.log(`    ${c.dim}· Claude Code skipped: ${r.detail ?? r.action}${c.reset}`);
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
      `  ${c.dim}· Permission allowlist: Claude Code · personal profile: Codex · auto-capture hooks: Claude Code, Codex${c.reset}\n` +
      `  ${c.dim}· Blocking install-gate: Claude Code, Codex, Amazon Q, Kiro, Factory Droid, Augment, Antigravity, Gemini CLI, Cursor (hooks), OpenCode (plugin), Cline (PreToolUse shim); Continue has no gate surface (#146)${c.reset}\n` +
      `  ${c.dim}The agent-agnostic enforcement floor is git hooks (${c.reset}${c.bold}kit hooks${c.reset}${c.dim}); the rules block only advises.${c.reset}`,
  );
  return !failed;
}

export async function cmdGovernance(): Promise<boolean> {
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
export async function cmdStatusline(): Promise<boolean> {
  process.env.KIT_NO_UPDATE_CHECK = "1"; // never let the post-command notice pollute the single line
  const { buildStatuslineText } = await import("../statusline.js");
  console.log(await buildStatuslineText({ modeFlag: flagValue(process.argv, "--mode") }));
  return true;
}

export async function cmdTeam(): Promise<boolean> {
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

        // flagInt, not a `--limit=`-only find: `kit team audit log --limit 3` printed
        // `(limit: 50)` — the flag parsed as nothing and the default won, silently. The old
        // form also had no NaN guard, so `--limit=abc` printed `(limit: NaN)`.
        const limit = flagInt(args, "--limit", 50);

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
