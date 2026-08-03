// `kit hooks` commands (git hook install/check/add) — extracted from cli.ts (split step 6).
import { loadConfig } from "../config.js";
import { resolveConfigPath, KIT_FILE } from "../cli-shared.js";
import { isGitRepository, checkHooks } from "../check-hooks.js";
import { installHooks, uninstallHooks } from "../hooks.js";
import { isNonInteractive } from "../environment.js";
import { promptConfirm } from "../utils/prompt.js";
import { c } from "../utils/colors.js";
import { ensureKitWrapper } from "../kit-wrapper.js";

const BUILTIN_HOOKS: Record<string, { hookName: string; commands: string[]; description: string }> =
  {
    "secret-scan": {
      hookName: "pre-commit",
      commands: ["kit security scan-staged"],
      description: "Block commits that stage known credential patterns (Stripe, AWS, JWT, etc).",
    },
    "post-pull-audit": {
      hookName: "post-merge",
      commands: ["kit security verify-pull"],
      description: "After git pull/merge, audit new deps, gitignore drops, and introduced secrets.",
    },
    "context-check": {
      hookName: "pre-push",
      commands: ["kit context check"],
      description:
        "Block a push when the live CLI context (account/project) does not match .kit.toml [context]. Stops pushes to the wrong org/project.",
    },
  };

export async function cmdHooks(): Promise<boolean> {
  const subcommand = process.argv[3];

  // Built-in hooks bypass the .kit.toml config path so they're available
  // on any repo, including ones that haven't run `kit init` yet.
  if (subcommand === "add") {
    return cmdHooksAdd();
  }

  const config = await loadConfig(resolveConfigPath());

  if (!config.hooks || Object.keys(config.hooks).length === 0) {
    console.log(`${c.dim}No hooks configured in ${KIT_FILE}${c.reset}`);
    return true;
  }

  if (!isGitRepository()) {
    console.log(`${c.red}Not a git repository${c.reset}`);
    return false;
  }

  if (subcommand === "install" || !subcommand) {
    console.log(`${c.bold}${c.cyan}Installing git hooks...${c.reset}\n`);

    // Ensure the self-healing wrapper exists before writing hooks, so the
    // generated hooks reference ~/.kit/bin/kit (resolves in a non-login shell).
    ensureKitWrapper();
    const results = await installHooks(config.hooks);
    let allOk = true;

    for (const r of results) {
      const icon = r.action === "failed" ? `${c.red}✗${c.reset}` : `${c.green}✓${c.reset}`;
      const label =
        r.action === "installed"
          ? `${c.green}installed${c.reset}`
          : r.action === "updated"
            ? `${c.green}updated${c.reset}`
            : r.action === "skipped"
              ? `${c.dim}skipped${c.reset}`
              : `${c.red}failed${c.reset}`;
      console.log(`  ${icon} ${r.hookName}  ${label}  ${c.dim}${r.detail}${c.reset}`);
      if (r.action === "failed") allOk = false;
    }

    console.log();
    return allOk;
  } else if (subcommand === "check") {
    console.log(`${c.bold}${c.cyan}Git Hooks${c.reset}\n`);

    const results = await checkHooks(config.hooks);
    let allOk = true;

    for (const r of results) {
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
      if (!r.installed || !r.upToDate) allOk = false;
    }

    if (!allOk) {
      console.log(
        `\n${c.dim}Run ${c.reset}${c.bold}kit hooks install${c.reset}${c.dim} to install/update hooks${c.reset}`,
      );
    }

    console.log();
    return allOk;
  } else if (subcommand === "uninstall") {
    // `uninstallHooks` has existed and been exported since hooks shipped, with no
    // caller: kit could install git hooks and had no way to remove them, so the only
    // route back was deleting files out of .git/hooks by hand. Reported by self-audit
    // rule 15 as unwired; this is the wire, not a new capability.
    console.log(`${c.bold}${c.cyan}Uninstalling git hooks...${c.reset}\n`);

    // `installHooks` writes the configured hooks AND the bypass-detector sentinel pair
    // (`pre-commit` writer + `post-commit` detector). Removing only the configured names
    // leaves the post-commit detector behind, and with the sentinel writer gone it then
    // reports every subsequent commit as "bypassed pre-commit (sentinel-missing)" —
    // forever. Found by running the uninstall and looking at .git/hooks afterwards
    // rather than trusting the happy-path output.
    const toRemove = [...new Set([...Object.keys(config.hooks), "pre-commit", "post-commit"])];
    const results = await uninstallHooks(toRemove);
    let allOk = true;

    for (const r of results) {
      const icon = r.action === "failed" ? `${c.red}✗${c.reset}` : `${c.green}✓${c.reset}`;
      // `uninstallHooks` reuses action "installed" to mean "removed" — render it as
      // what actually happened rather than leaking that quirk to the operator.
      const label =
        r.action === "failed"
          ? `${c.red}failed${c.reset}`
          : r.action === "skipped"
            ? `${c.dim}skipped${c.reset}`
            : `${c.green}removed${c.reset}`;
      console.log(`  ${icon} ${r.hookName}  ${label}  ${c.dim}${r.detail}${c.reset}`);
      if (r.action === "failed") allOk = false;
    }

    console.log();
    if (allOk) {
      console.log(
        `${c.dim}Enforcement is now off for these hooks — re-install with ${c.reset}${c.bold}kit hooks install${c.reset}${c.dim}.${c.reset}\n`,
      );
    }
    return allOk;
  } else {
    console.error(`Unknown hooks subcommand: ${subcommand}`);
    console.error(`Usage: kit hooks [install|check|uninstall|add <name>]`);
    return false;
  }
}

async function cmdHooksAdd(): Promise<boolean> {
  const name = process.argv[4];

  if (!name) {
    console.error(
      `${c.red}Usage: kit hooks add <name>${c.reset}\n${c.dim}Available built-in hooks:${c.reset}`,
    );
    for (const [k, v] of Object.entries(BUILTIN_HOOKS)) {
      console.error(`  ${c.bold}${k}${c.reset} (git ${v.hookName}) — ${v.description}`);
    }
    return false;
  }

  const builtin = BUILTIN_HOOKS[name];
  if (!builtin) {
    console.error(`${c.red}No built-in hook named "${name}"${c.reset}`);
    console.error(`${c.dim}Available: ${Object.keys(BUILTIN_HOOKS).join(", ")}${c.reset}`);
    return false;
  }

  if (!isGitRepository()) {
    console.error(`${c.red}Not a git repository${c.reset}`);
    return false;
  }

  console.log(
    `${c.bold}${c.cyan}kit hooks add ${name}${c.reset}  ${c.dim}(git ${builtin.hookName})${c.reset}`,
  );
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  // Check whether the target hook is already present and contains a kit-
  // managed step. If so, just confirm without re-writing.
  const { hooksDir } = await ensureHooksDir();
  const hookPath = `${hooksDir}/${builtin.hookName}`;

  const { existsSync, readFileSync } = await import("node:fs");
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (existing.includes(builtin.commands[0])) {
      console.log(
        `  ${c.green}✓${c.reset} ${builtin.hookName} already has ${c.bold}${builtin.commands[0]}${c.reset}\n`,
      );
      return true;
    }
    console.log(`${c.yellow}⚠ ${builtin.hookName} already exists at ${hookPath}.${c.reset}`);
    console.log(
      `${c.dim}kit will overwrite it with a managed version that calls back into kit.${c.reset}\n`,
    );
    if (!isNonInteractive()) {
      const ok = await promptConfirm(`Overwrite? [Y/n] (auto-yes in 8s): `, 8000);
      if (!ok) {
        console.log(`${c.dim}Aborted.${c.reset}`);
        return false;
      }
    }
  }

  // Wrapper first so the generated hook embeds its absolute path.
  ensureKitWrapper();
  const results = await installHooks({ [builtin.hookName]: builtin.commands });
  const r = results[0];
  if (r.action === "failed") {
    console.error(`${c.red}✗ install failed: ${r.detail}${c.reset}`);
    return false;
  }

  console.log(
    `  ${c.green}✓${c.reset} ${builtin.hookName}  ${c.green}${r.action}${c.reset}  ${c.dim}${r.detail}${c.reset}`,
  );
  console.log(
    `\n${c.dim}Test by staging a file with a fake credential (e.g. ${c.bold}sk_${"test"}_${"A".repeat(20)}${c.reset}${c.dim}) and running ${c.bold}git commit${c.reset}${c.dim} — the commit should be blocked.${c.reset}\n`,
  );
  return true;
}

async function ensureHooksDir(): Promise<{ hooksDir: string }> {
  const { resolve } = await import("node:path");
  return { hooksDir: resolve(process.cwd(), ".git", "hooks") };
}
