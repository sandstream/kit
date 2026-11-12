import { installTools } from "./install.js";
import {
  readkitMeta,
  readSkillsLock,
  readCliLock,
  updateSkillsLock,
  updateCliLock,
} from "./lock.js";

import { resolve } from "node:path";
import { loadConfig, type kitConfig } from "./config.js";
import { withGovernance } from "./governance-middleware.js";
import { checkTools } from "./check-tools.js";
import { checkServices } from "./check-services.js";
import { buildVercelDeployTargets, checkDeploy } from "./check-deploy.js";
import { resolveViaBackend } from "./secret-backends.js";
import { propagate } from "./secrets-propagate.js";
import { installHooks } from "./hooks.js";
import { patchGitignore } from "./check-gitignore.js";
import { generateSecretsTemplate } from "./fix-template.js";
import { c } from "./utils/colors.js";
import { formatHitlBlocks, hitlBlockForService, type HitlBlock } from "./hitl.js";

export interface FixResult {
  category: "tool" | "service" | "lock" | "secret";
  name: string;
  action: "fixed" | "already_ok" | "needs_manual" | "failed";
  detail: string;
}

function deployManualBlock(input: {
  blocker: string;
  reason: string;
  steps: string[];
  respondWith: string;
}): HitlBlock {
  return {
    blocker: input.blocker,
    owner: "developer",
    reason: input.reason,
    steps: input.steps,
    respondWith: input.respondWith,
    agentContinuesWith: "kit check --category deploy",
  };
}

async function fixDeploy(
  config: kitConfig,
  cwd: string,
): Promise<{
  fixedCount: number;
  manualActions: HitlBlock[];
}> {
  if (!config.deploy) return { fixedCount: 0, manualActions: [] };

  let fixedCount = 0;
  const manualActions: HitlBlock[] = [];
  console.log(`${c.bold}[deploy] Deploy Env${c.reset}`);

  const deployResults = await checkDeploy(config.deploy, cwd);
  for (const row of deployResults.filter((r) => r.status === "fail" && r.didNotRun)) {
    manualActions.push(
      deployManualBlock({
        blocker: `${row.provider} deploy env check did not run for ${row.project}/${row.environment}`,
        reason: "provider CLI auth / setup",
        steps: [`Fix provider CLI setup: ${row.detail}.`, "Run `kit check --category deploy`."],
        respondWith: `${row.provider} deploy env check runs; no secret values pasted`,
      }),
    );
  }
  const missingRows = deployResults.filter(
    (r) => r.provider === "vercel" && (r.missing?.length ?? 0) > 0,
  );
  if (missingRows.length === 0) {
    console.log(
      manualActions.length > 0
        ? `${c.dim}Deploy env check needs human setup before kit can fix missing keys${c.reset}`
        : `${c.dim}No missing deploy env key names${c.reset}`,
    );
    console.log();
    return { fixedCount, manualActions };
  }

  const vercelTargets = config.deploy.vercel
    ? buildVercelDeployTargets(config.deploy.vercel, cwd)
    : [];
  const targetByKey = new Map(
    vercelTargets.map((target) => [`${target.environment}\0${target.project}`, target]),
  );

  for (const row of missingRows) {
    const target = targetByKey.get(`${row.environment}\0${row.project}`);
    if (!target?.remoteEnv) {
      manualActions.push(
        deployManualBlock({
          blocker: `${row.project}/${row.environment} deploy target is ambiguous`,
          reason: "deploy config / provider target",
          steps: [
            `Add remote_env = "production", "preview", or "development" under [deploy.vercel.environments.${row.environment}], or set ${row.missing?.join(", ")} manually in Vercel.`,
            "Run `kit check --category deploy`.",
          ],
          respondWith: `${row.project}/${row.environment} has an explicit Vercel remote_env or env vars set; no secret values pasted`,
        }),
      );
      continue;
    }

    for (const key of row.missing ?? []) {
      const keyConfig = config.secrets?.keys?.[key];
      if (!keyConfig) {
        manualActions.push(
          deployManualBlock({
            blocker: `${key} has no declared secret source for ${row.project}/${row.environment}`,
            reason: "secret / deploy config",
            steps: [
              `Add ${key} to [secrets.keys] with a vault-backed source, or set it directly in Vercel project ${row.project}.`,
              row.buildTime?.includes(key)
                ? `Redeploy ${row.project} after setting build-time key ${key}.`
                : `Run \`kit check --category deploy\`.`,
            ],
            respondWith: `${key} source declared or key set in Vercel; no secret values pasted`,
          }),
        );
        continue;
      }

      const resolved = await resolveViaBackend(key, keyConfig, config.secrets?.infisical);
      if (!resolved.resolved || !resolved.value || resolved.managed) {
        manualActions.push(
          deployManualBlock({
            blocker: `${key} value is unavailable for ${row.project}/${row.environment}`,
            reason: "secret backend auth / setup",
            steps: [
              `Make ${key} available through the configured ${keyConfig.source} backend: ${resolved.detail}.`,
              "Run `kit fix`, then `kit check --category deploy`.",
            ],
            respondWith: `${key} available in configured secret backend; no secret values pasted`,
          }),
        );
        continue;
      }

      const [result] = await propagate(key, resolved.value, ["vercel"], {
        env: target.remoteEnv,
        vercelScope: target.scope,
        vercelProject: target.project,
        vercelTeamId: target.teamId,
        vercelCwd: target.cwd,
        policy: config.policy,
        cwd,
      });
      if (result?.ok) {
        console.log(
          `  ${c.green}✓${c.reset} ${key}  ${c.green}pushed${c.reset}  ${c.dim}vercel project=${row.project} env=${target.remoteEnv}${c.reset}`,
        );
        if (row.buildTime?.includes(key)) {
          console.log(
            `    ${c.yellow}Redeploy required before the built frontend sees ${key}${c.reset}`,
          );
        }
        fixedCount++;
      } else {
        manualActions.push(
          deployManualBlock({
            blocker: `${key} could not be pushed to ${row.project}/${row.environment}`,
            reason: "provider CLI auth / setup",
            steps: [
              result?.detail ?? "Vercel propagation failed.",
              `Set ${key} manually in Vercel project ${row.project} for ${target.remoteEnv}.`,
              "Run `kit check --category deploy`.",
            ],
            respondWith: `${key} present in Vercel; no secret values pasted`,
          }),
        );
      }
    }
  }

  console.log();
  return { fixedCount, manualActions };
}

/**
 * `kit fix` — auto-remediation pipeline. Six core steps: install missing
 * tools, generate lock files, surface unauthenticated services, generate
 * .env.template, harden .gitignore, install git hooks. When [deploy] is
 * configured, it also pushes missing deploy env values that can be resolved
 * from [secrets.keys]. Returns false when any step requires manual intervention.
 *
 * Extracted from cli.ts (codebase-review follow-up).
 */
/**
 * Write `.kit/cli-lock.json` from what is installed. Measured, not assumed: both lock writers
 * used to record the DECLARED string and hardcode `source: "mise"`, so `{"vercel":{"version":
 * "latest","source":"mise"}}` described a Homebrew binary and `kit check` called it in sync
 * (#500). A tool whose installed version misses its pin writes no lock at all.
 */
async function generateCliLock(config: kitConfig, cwd: string): Promise<boolean> {
  const { resolveLockEntries, isLockMismatchError } = await import("./tool-inventory.js");
  let tools: Awaited<ReturnType<typeof resolveLockEntries>> = {};
  if (config.tools) {
    try {
      tools = await resolveLockEntries(config.tools);
    } catch (err) {
      if (!isLockMismatchError(err)) throw err;
      console.log(`  ${c.yellow}!${c.reset} cli-lock.json not generated: ${err.message}`);
      return false;
    }
  }
  await updateCliLock(tools, cwd);
  console.log(`  ${c.green}✓${c.reset} Generated cli-lock.json`);
  return true;
}

/** Print the template write failure and return the manual action that replaces it. */
function templateFailure(templatePath: string, keyCount: number, err: unknown): HitlBlock {
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`  ${c.red}✗${c.reset} Failed to write ${templatePath}: ${msg}`);
  return {
    blocker: `${templatePath} could not be created`,
    owner: "developer",
    reason: "local file permission / config",
    steps: [`Add ${keyCount} key placeholder(s).`, "Run `kit check --category secrets`."],
    respondWith: `${templatePath} exists; no secret values pasted`,
    agentContinuesWith: "kit check --category secrets",
  };
}

/** What the pipeline has done so far: fixes made by kit and actions left for a human. */
interface FixState {
  fixed: number;
  manual: HitlBlock[];
}

/** A manual action for a developer. Every block `kit fix` raises has the same owner. */
function developerBlock(fields: Omit<HitlBlock, "owner">): HitlBlock {
  return { ...fields, owner: "developer" };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Step 1: install the tools that `[tools]` declares and that are missing. */
async function fixTools(config: kitConfig, state: FixState): Promise<void> {
  if (!config.tools || Object.keys(config.tools).length === 0) return;
  console.log(`${c.bold}[1/6] Tools${c.reset}`);
  const missingTools = (await checkTools(config.tools)).filter((t) => !t.ok);

  if (missingTools.length === 0) {
    console.log(`${c.dim}All tools installed${c.reset}`);
    console.log();
    return;
  }
  console.log(`${c.dim}Installing ${missingTools.length} missing tool(s)...${c.reset}\n`);
  for (const r of await installTools(config.tools)) {
    if (r.action === "installed") {
      console.log(
        `  ${c.green}✓${c.reset} ${r.name}  ${c.green}installed${c.reset}  ${c.dim}${r.detail}${c.reset}`,
      );
      state.fixed++;
    } else if (r.action === "failed") {
      console.log(
        `  ${c.red}✗${c.reset} ${r.name}  ${c.red}failed${c.reset}  ${c.dim}${r.detail}${c.reset}`,
      );
      state.manual.push(
        developerBlock({
          blocker: `${r.name} tool is not installable by kit`,
          reason: "local tool setup",
          steps: [r.detail, "Run `kit check --category tools`."],
          respondWith: `${r.name} installed or intentionally unavailable`,
          agentContinuesWith: "kit check --category tools",
        }),
      );
    }
  }
  console.log();
}

/** Write `.kit/skills-lock.json` from the `[skills]` tables. */
async function generateSkillsLock(config: kitConfig, cwd: string): Promise<void> {
  const skills: Record<string, string> = {};
  if (config.skills?.required) Object.assign(skills, config.skills.required);
  if (config.skills?.optional) Object.assign(skills, config.skills.optional);

  const kitMeta = await readkitMeta(cwd);
  await updateSkillsLock(
    skills,
    kitMeta?.name ? `${kitMeta.name}@${kitMeta.version}` : undefined,
    cwd,
  );
  console.log(`  ${c.green}✓${c.reset} Generated skills-lock.json`);
}

/** Step 2: generate the lock files that are missing. */
async function fixLockFiles(config: kitConfig, cwd: string, state: FixState): Promise<void> {
  console.log(`${c.bold}[2/6] Lock Files${c.reset}`);
  const skillsLock = await readSkillsLock(cwd);
  const cliLock = await readCliLock(cwd);

  if (skillsLock && cliLock) {
    console.log(`${c.dim}Lock files exist${c.reset}`);
  } else {
    console.log(`${c.dim}Generating missing lock files...${c.reset}\n`);
    if (!skillsLock) {
      await generateSkillsLock(config, cwd);
      state.fixed++;
    }
    if (!cliLock && (await generateCliLock(config, cwd))) state.fixed++;
  }
  console.log();
}

/** Step 3: list the services that need a manual login. */
async function fixServices(config: kitConfig, state: FixState): Promise<void> {
  console.log(`${c.bold}[3/6] Services${c.reset}`);
  if (!config.services || Object.keys(config.services).length === 0) {
    console.log(`${c.dim}No services configured${c.reset}`);
    console.log();
    return;
  }
  const unauthenticated = (await checkServices(config.services)).filter((s) => !s.authenticated);
  if (unauthenticated.length === 0) {
    console.log(`${c.dim}All services authenticated${c.reset}`);
  } else {
    console.log(
      `${c.yellow}${unauthenticated.length} service(s) require manual authentication${c.reset}\n`,
    );
    for (const s of unauthenticated) {
      console.log(
        `  ${c.yellow}!${c.reset} ${s.name}  ${c.yellow}not authenticated${c.reset}  ${c.dim}${s.output}${c.reset}`,
      );
      const block = hitlBlockForService(s, config);
      if (block) state.manual.push(block);
    }
  }
  console.log();
}

/** Step 4: generate `.env.template` when secret keys are declared and the template is missing. */
async function fixSecretsTemplate(config: kitConfig, cwd: string, state: FixState): Promise<void> {
  console.log(`${c.bold}[4/6] Secrets Template${c.reset}`);
  // `template` is a repo-relative path in .kit.toml. Resolve against the governed
  // project and create exclusively, so another writer cannot replace an absence probe.
  const templateRel = config.secrets?.template;
  const templatePath = templateRel ? resolve(cwd, templateRel) : undefined;
  if (templatePath && config.secrets?.keys && Object.keys(config.secrets.keys).length > 0) {
    const keyNames = Object.keys(config.secrets.keys);
    try {
      const template = await generateSecretsTemplate(config.secrets, cwd);
      if (template?.written) {
        console.log(
          `  ${c.green}✓${c.reset} Generated ${templatePath}  ${c.dim}(${keyNames.length} keys)${c.reset}`,
        );
        state.fixed++;
      } else {
        console.log(`${c.dim}Template ${templatePath} exists${c.reset}`);
      }
    } catch (err: unknown) {
      state.manual.push(templateFailure(templatePath, keyNames.length, err));
    }
  } else {
    console.log(`${c.dim}No secrets template configured${c.reset}`);
  }
  console.log();
}

/** Step 5: make Git ignore `.env*`, `*.pem`, `id_rsa` and `.kit/elevation.json`. Idempotent. */
async function fixGitignore(cwd: string, state: FixState): Promise<void> {
  console.log(`${c.bold}[5/6] .gitignore${c.reset}`);
  try {
    const patch = await patchGitignore(cwd);
    if (patch.written) {
      console.log(`  ${c.green}✓${c.reset} Repaired .gitignore protection and verified with Git`);
      state.fixed++;
    } else {
      console.log(`${c.dim}.gitignore already hardened${c.reset}`);
    }
  } catch (err: unknown) {
    const msg = errorMessage(err);
    console.log(`  ${c.red}✗${c.reset} .gitignore harden failed: ${msg}`);
    state.manual.push(
      developerBlock({
        blocker: ".gitignore could not be hardened",
        reason: msg,
        steps: [
          "Review Git availability, remaining ignore overrides, and already tracked sensitive files.",
          "Run `kit check`.",
        ],
        respondWith: ".gitignore hardened",
        agentContinuesWith: "kit check",
      }),
    );
  }
  console.log();
}

type HookResults = Awaited<ReturnType<typeof installHooks>>;

/** Sort the install results into the groups the report prints. */
function groupHookResults(hookResults: HookResults, configured: Set<string>) {
  const isConfigured = (r: HookResults[number]) => configured.has(r.hookName);
  const skipped = hookResults.filter((r) => r.action === "skipped" && isConfigured(r));
  return {
    installed: hookResults.filter((r) => r.action === "installed" && isConfigured(r)),
    updated: hookResults.filter((r) => r.action === "updated" && isConfigured(r)),
    auxiliary: hookResults.filter(
      (r) => (r.action === "installed" || r.action === "updated") && !isConfigured(r),
    ),
    skipped,
    satisfiedSkipped: skipped.filter((r) => r.satisfied),
    blockedSkipped: skipped.filter((r) => !r.satisfied),
    failed: hookResults.filter((r) => r.action === "failed"),
  };
}

function hookNames(results: HookResults): string {
  return results.map((r) => r.hookName).join(", ");
}

/** Print the hook install report and raise a manual action for each hook that kit could not place. */
function reportHookResults(hookResults: HookResults, configured: Set<string>, state: FixState) {
  const g = groupHookResults(hookResults, configured);
  if (g.installed.length > 0) {
    console.log(
      `  ${c.green}✓${c.reset} Installed ${g.installed.length} hook(s): ${hookNames(g.installed)}`,
    );
    state.fixed++;
  }
  if (g.updated.length > 0) {
    console.log(
      `  ${c.dim}↻ Updated ${g.updated.length} existing hook(s): ${hookNames(g.updated)}${c.reset}`,
    );
  }
  if (g.auxiliary.length > 0) {
    console.log(`  ${c.dim}↻ Hook support installed/updated: ${hookNames(g.auxiliary)}${c.reset}`);
  }
  if (g.satisfiedSkipped.length > 0) {
    console.log(
      `  ${c.green}✓${c.reset} Externally managed hook(s) already satisfy config: ${hookNames(g.satisfiedSkipped)}`,
    );
  }
  for (const s of g.blockedSkipped) {
    console.log(`  ${c.yellow}!${c.reset} ${s.hookName}: ${s.detail}`);
    state.manual.push(
      developerBlock({
        blocker: `${s.hookName} hook was left untouched`,
        reason: "existing non-kit git hook",
        steps: [s.detail, "Run `kit check --category hooks`."],
        respondWith: `${s.hookName} hook includes the configured kit commands or is intentionally unmanaged`,
        agentContinuesWith: "kit check --category hooks",
      }),
    );
  }
  for (const f of g.failed) {
    console.log(`  ${c.red}✗${c.reset} ${f.hookName}: ${f.detail}`);
    state.manual.push(
      developerBlock({
        blocker: `${f.hookName} hook could not be installed`,
        reason: "local git hook setup",
        steps: [f.detail, "Run `kit check --category hooks`."],
        respondWith: `${f.hookName} hook installed or intentionally skipped`,
        agentContinuesWith: "kit check --category hooks",
      }),
    );
  }
  const nothingToReport = [g.installed, g.updated, g.auxiliary, g.skipped, g.failed].every(
    (group) => group.length === 0,
  );
  if (nothingToReport) console.log(`${c.dim}Hooks up to date${c.reset}`);
}

/**
 * Step 6: install the git hooks that `[hooks]` declares. Reuses `installHooks()` from
 * `kit hooks`, so the same bypass-detector pair lands too.
 */
async function fixHooks(config: kitConfig, cwd: string, state: FixState): Promise<void> {
  console.log(`${c.bold}[6/6] Git Hooks${c.reset}`);
  const hooks = config.hooks;
  if (!hooks || Object.keys(hooks).length === 0) {
    console.log(`${c.dim}No hooks configured in .kit.toml${c.reset}`);
    console.log();
    return;
  }
  try {
    const hookResults = await installHooks(hooks, ".git", cwd);
    const configured = new Set(
      Object.entries(hooks)
        .filter(([, commands]) => commands && commands.length > 0)
        .map(([name]) => name),
    );
    reportHookResults(hookResults, configured, state);
  } catch (err: unknown) {
    console.log(`  ${c.red}✗${c.reset} Hooks install failed: ${errorMessage(err)}`);
    state.manual.push(
      developerBlock({
        blocker: "git hooks could not be installed",
        reason: "local git hook setup",
        steps: [`Run \`kit hooks install\`.`, "Run `kit check --category hooks`."],
        respondWith: "git hooks installed or intentionally skipped",
        agentContinuesWith: "kit check --category hooks",
      }),
    );
  }
  console.log();
}

function printFixSummary(state: FixState): void {
  console.log(`${c.bold}${c.cyan}Summary${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (state.fixed > 0) {
    console.log(`  ${c.green}✓${c.reset} Fixed ${state.fixed} issue(s) automatically`);
  }
  if (state.manual.length > 0) {
    console.log(`  ${c.yellow}!${c.reset} ${state.manual.length} issue(s) require human action:\n`);
    console.log(formatHitlBlocks(state.manual));
    console.log();
    console.log(
      `${c.dim}Run ${c.reset}${c.bold}kit check${c.reset}${c.dim} to verify status after manual fixes${c.reset}`,
    );
  } else if (state.fixed === 0) {
    console.log(`  ${c.green}✓${c.reset} Nothing to fix — all checks passing`);
  }
  console.log();
}

/** The pipeline body. Returns false when any step left a manual action. */
async function runFixPipeline(config: kitConfig, cwd: string): Promise<boolean> {
  // Read-only mode: fix installs tools and writes .env.template / .gitignore.
  // Refuse the whole pipeline up front + audit, so no sink runs (matches
  // installHooks). withGovernance never consults read-only, so guard here.
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("fix", {}, { cwd });
    console.log(`  ${c.yellow}!${c.reset} ${refusal.reason}`);
    return false;
  }

  const state: FixState = { fixed: 0, manual: [] };
  await fixTools(config, state);
  await fixLockFiles(config, cwd, state);
  await fixServices(config, state);
  await fixSecretsTemplate(config, cwd, state);
  await fixGitignore(cwd, state);
  await fixHooks(config, cwd, state);

  const deployFix = await fixDeploy(config, cwd);
  state.fixed += deployFix.fixedCount;
  state.manual.push(...deployFix.manualActions);

  printFixSummary(state);
  return state.manual.length === 0;
}

export async function cmdFix(cwd: string = process.cwd()): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit fix${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const config = await loadConfig(resolve(cwd, ".kit.toml"));

  return await withGovernance(
    config,
    {
      operation: "fix",
      operationType: "write",
      metadata: {},
      // Declared effects (scope-needs adoption): the statically-known repo writes.
      // Tool installs go through mise into $HOME — infrastructure provisioning the
      // project [scope] RoE does not govern (mirrors the MCP kit_fix site's
      // `infrastructure: true`). Git-hook installs resolve their target via
      // `core.hooksPath` at runtime. They land inside the repo ONLY when hooksPath is unset or
      // repo-relative: an absolute hooksPath pointing at another checkout puts the write
      // outside the repo, i.e. outside what a repo-rooted [scope].fs covers (measured in #496).
      // `kit check`'s "git hook floor" row reports that case; declaring the resolved directory
      // here would need a dynamic scopeNeeds, which this static declaration cannot express.
      scopeNeeds: {
        fsWrites: ["skills-lock.json", "cli-lock.json", ".env.template", ".gitignore"],
      },
    },
    () => runFixPipeline(config, cwd),
    // Audit the fix in the tree being fixed, not in whatever directory the process sits in.
    { cwd },
  );
}
