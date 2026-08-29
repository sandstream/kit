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
      // --require-declaration: without a [context] block the check has nothing to compare
      // against, and a push gate that always passes is worse than no gate (#497).
      commands: ["kit context check --require-declaration"],
      description:
        "Block a push when the live CLI context (account/project) does not match .kit.toml [context]. Stops pushes to the wrong org/project.",
    },
  };

function printBuiltinHooks(): void {
  for (const [k, v] of Object.entries(BUILTIN_HOOKS)) {
    console.log(`  ${c.bold}${k}${c.reset} (git ${v.hookName}) — ${v.description}`);
  }
}

function printNoConfiguredHooks(subcommand: string | undefined): void {
  console.log(
    `${c.dim}No hooks configured: No [hooks] section configured in ${KIT_FILE}; nothing to install.${c.reset}`,
  );
  if (subcommand === "install" || !subcommand) {
    console.log(
      `${c.dim}${c.bold}kit hooks install${c.reset}${c.dim} only installs hooks declared in ${KIT_FILE}.${c.reset}`,
    );
    console.log(
      `${c.dim}For kit's built-in hooks, run ${c.reset}${c.bold}kit hooks add <name>${c.reset}${c.dim}:${c.reset}`,
    );
    printBuiltinHooks();
  }
}

export async function cmdHooks(): Promise<boolean> {
  const subcommand = process.argv[3];

  // Built-in hooks bypass the .kit.toml config path so they're available
  // on any repo, including ones that haven't run `kit init` yet.
  if (subcommand === "add") {
    return cmdHooksAdd();
  }

  const config = await loadConfig(resolveConfigPath());

  if (!config.hooks || Object.keys(config.hooks).length === 0) {
    printNoConfiguredHooks(subcommand);
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
      const ok = r.action !== "failed" && (r.action !== "skipped" || r.satisfied === true);
      const icon =
        r.action === "failed"
          ? `${c.red}✗${c.reset}`
          : ok
            ? `${c.green}✓${c.reset}`
            : `${c.yellow}!${c.reset}`;
      const label =
        r.action === "installed"
          ? `${c.green}installed${c.reset}`
          : r.action === "updated"
            ? `${c.green}updated${c.reset}`
            : r.action === "skipped"
              ? `${c.dim}skipped${c.reset}`
              : `${c.red}failed${c.reset}`;
      console.log(`  ${icon} ${r.hookName}  ${label}  ${c.dim}${r.detail}${c.reset}`);
      if (!ok) allOk = false;
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

  // A gate that cannot fail must not be installed silently. `kit context check` with no
  // [context] block has nothing to compare the live CLI state against, so the pre-push hook
  // passed unconditionally while reporting `✓ installed` (#497) — the false green kit exists
  // to refuse. --force installs anyway, for someone who is about to add the block.
  if (name === "context-check") {
    const { hasFlag } = await import("../utils/flags.js");
    const cfg = await loadConfig(resolveConfigPath()).catch(() => null);
    if (!cfg?.context && !hasFlag(process.argv, "--force")) {
      console.error(
        `${c.red}✗ refusing to install context-check: no [context] block in ${KIT_FILE}.${c.reset}`,
      );
      console.error(
        `${c.dim}The hook runs \`kit context check\`, which has nothing to compare against without one — it would pass every push and report a gate you do not have.${c.reset}`,
      );
      console.error(
        `${c.dim}Run ${c.bold}kit context check${c.reset}${c.dim} first: it prints a ready-to-paste [context] block from the live CLI state. Then re-run this. Or ${c.bold}--force${c.reset}${c.dim} to install it now and declare the block after.${c.reset}`,
      );
      return false;
    }
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
  // Where it landed, when that is not inside the repo. `✓ installed` with no path is what let a
  // floor live in another clone's tree unnoticed (#496).
  const { describeHookFloor } = await import("../hook-floor.js");
  const floor = describeHookFloor(process.cwd());
  if (floor.external) {
    console.log(
      `\n  ${c.yellow}!${c.reset} written to ${c.bold}${floor.dir}${c.reset} ${c.dim}— OUTSIDE this repo (core.hooksPath).` +
        ` Hooks fire, but deleting that directory silently removes the gate.${c.reset}` +
        `\n    ${c.dim}keep the floor in the repo with:${c.reset} git config --unset core.hooksPath`,
    );
  }

  // Per-hook test recipe. Every hook used to print secret-scan's, which tells you to stage a
  // credential and commit — advice that exercises nothing for a pre-push or post-merge gate.
  console.log(`\n${c.dim}${TEST_HINTS[name]}${c.reset}\n`);
  return true;
}

/** How to actually exercise each built-in hook, so the hint matches the hook. */
const TEST_HINTS: Record<string, string> = {
  "secret-scan": `Test: stage a file containing sk_${"test"}_${"A".repeat(20)} and run git commit — the commit should be blocked.`,
  "post-pull-audit":
    "Test: merge or pull a branch that adds a dependency — the audit runs after the merge and reports new deps, gitignore drops and introduced secrets.",
  "context-check":
    "Test: temporarily change one value in [context] (e.g. github.org) and run `kit context check` — it must exit 1 naming the mismatch. Restore it afterwards.",
};

/**
 * The directory the install will actually write to — `resolveHooksDir()`, not
 * `<repo>/.git/hooks`. The already-installed pre-check below reads this; when it hardcoded
 * `.git/hooks` and `core.hooksPath` pointed elsewhere, the check looked at an empty directory
 * and every run reported a fresh "installed" for a hook that was already there (#496).
 */
async function ensureHooksDir(): Promise<{ hooksDir: string }> {
  const { resolveHooksDir } = await import("../hooks.js");
  return { hooksDir: resolveHooksDir(".git", process.cwd()) };
}
