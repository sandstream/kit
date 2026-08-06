import { installTools } from "./install.js";
import {
  readkitMeta,
  readSkillsLock,
  readCliLock,
  updateSkillsLock,
  updateCliLock,
} from "./lock.js";

import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, type kitConfig } from "./config.js";
import { withGovernance } from "./governance-middleware.js";
import { checkTools } from "./check-tools.js";
import { checkServices } from "./check-services.js";
import { buildVercelDeployTargets, checkDeploy } from "./check-deploy.js";
import { resolveViaBackend } from "./secret-backends.js";
import { propagate } from "./secrets-propagate.js";
import { installHooks } from "./hooks.js";
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
export async function cmdFix(cwd: string = process.cwd()): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit fix${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const config = await loadConfig(resolve(cwd, ".kit.toml"));

  let fixedCount = 0;
  let manualCount = 0;
  const manualActions: HitlBlock[] = [];

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
      // `core.hooksPath` at runtime; they land inside the repo, which the
      // repo-rooted [scope].fs covers.
      scopeNeeds: {
        fsWrites: ["skills-lock.json", "cli-lock.json", ".env.template", ".gitignore"],
      },
    },
    async () => {
      // Read-only mode: fix installs tools and writes .env.template / .gitignore.
      // Refuse the whole pipeline up front + audit, so no sink runs (matches
      // installHooks). withGovernance never consults read-only, so guard here.
      const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
      if (isReadOnlyMode()) {
        const refusal = await refuseWrite("fix", {}, { cwd });
        console.log(`  ${c.yellow}!${c.reset} ${refusal.reason}`);
        return false;
      }

      // 1. Check and fix missing tools
      if (config.tools && Object.keys(config.tools).length > 0) {
        console.log(`${c.bold}[1/6] Tools${c.reset}`);
        const toolResults = await checkTools(config.tools);
        const missingTools = toolResults.filter((t) => !t.ok);

        if (missingTools.length > 0) {
          console.log(`${c.dim}Installing ${missingTools.length} missing tool(s)...${c.reset}\n`);
          const installResults = await installTools(config.tools);

          for (const r of installResults) {
            if (r.action === "installed") {
              const icon = `${c.green}✓${c.reset}`;
              console.log(
                `  ${icon} ${r.name}  ${c.green}installed${c.reset}  ${c.dim}${r.detail}${c.reset}`,
              );
              fixedCount++;
            } else if (r.action === "failed") {
              const icon = `${c.red}✗${c.reset}`;
              console.log(
                `  ${icon} ${r.name}  ${c.red}failed${c.reset}  ${c.dim}${r.detail}${c.reset}`,
              );
              manualActions.push({
                blocker: `${r.name} tool is not installable by kit`,
                owner: "developer",
                reason: "local tool setup",
                steps: [r.detail, "Run `kit check --category tools`."],
                respondWith: `${r.name} installed or intentionally unavailable`,
                agentContinuesWith: "kit check --category tools",
              });
              manualCount++;
            }
          }
        } else {
          console.log(`${c.dim}All tools installed${c.reset}`);
        }
        console.log();
      }

      // 2. Check and fix missing lock files
      console.log(`${c.bold}[2/6] Lock Files${c.reset}`);
      const skillsLock = await readSkillsLock(cwd);
      const cliLock = await readCliLock(cwd);

      if (!skillsLock || !cliLock) {
        console.log(`${c.dim}Generating missing lock files...${c.reset}\n`);

        // Generate skills lock
        if (!skillsLock) {
          const skills: Record<string, string> = {};
          if (config.skills?.required) {
            Object.assign(skills, config.skills.required);
          }
          if (config.skills?.optional) {
            Object.assign(skills, config.skills.optional);
          }

          const kitMeta = await readkitMeta(cwd);
          await updateSkillsLock(
            skills,
            kitMeta?.name ? `${kitMeta.name}@${kitMeta.version}` : undefined,
            cwd,
          );
          console.log(`  ${c.green}✓${c.reset} Generated skills-lock.json`);
          fixedCount++;
        }

        // Generate CLI lock
        if (!cliLock) {
          const tools: Record<
            string,
            { version: string; source: "mise" | "npm" | "pip" | "manual"; auth?: string }
          > = {};
          if (config.tools) {
            for (const [name, version] of Object.entries(config.tools)) {
              tools[name] = { version, source: "mise" };
            }
          }

          await updateCliLock(tools, cwd);
          console.log(`  ${c.green}✓${c.reset} Generated cli-lock.json`);
          fixedCount++;
        }
      } else {
        console.log(`${c.dim}Lock files exist${c.reset}`);
      }
      console.log();

      // 3. Check services that need manual login
      console.log(`${c.bold}[3/6] Services${c.reset}`);
      if (config.services && Object.keys(config.services).length > 0) {
        const serviceResults = await checkServices(config.services);
        const unauthenticated = serviceResults.filter((s) => !s.authenticated);

        if (unauthenticated.length > 0) {
          console.log(
            `${c.yellow}${unauthenticated.length} service(s) require manual authentication${c.reset}\n`,
          );
          for (const s of unauthenticated) {
            console.log(
              `  ${c.yellow}!${c.reset} ${s.name}  ${c.yellow}not authenticated${c.reset}  ${c.dim}${s.output}${c.reset}`,
            );
            const block = hitlBlockForService(s, config);
            if (block) {
              manualActions.push(block);
              manualCount++;
            }
          }
        } else {
          console.log(`${c.dim}All services authenticated${c.reset}`);
        }
      } else {
        console.log(`${c.dim}No services configured${c.reset}`);
      }
      console.log();

      // 4. Generate .env.template if secrets keys configured but template missing
      console.log(`${c.bold}[4/6] Secrets Template${c.reset}`);
      // `template` is a repo-relative path in .kit.toml, so both the existence probe and the
      // write must resolve against the GOVERNED project. Bare `access(templatePath)` /
      // `writeFile(templatePath)` resolved against the calling process, which is how a fix asked
      // to repair B could report A's template as present — or create B's template inside A.
      const templateRel = config.secrets?.template;
      const templatePath = templateRel ? resolve(cwd, templateRel) : undefined;
      if (templatePath && config.secrets?.keys && Object.keys(config.secrets.keys).length > 0) {
        let templateExists: boolean;
        try {
          await access(templatePath);
          templateExists = true;
        } catch {
          templateExists = false;
        }
        if (templateExists) {
          console.log(`${c.dim}Template ${templatePath} exists${c.reset}`);
        } else {
          const keyNames = Object.keys(config.secrets.keys);
          const body = [
            `# .env.template — generated by kit fix`,
            `# Fill in real values in .env.local (do NOT commit .env.local).`,
            ``,
            ...keyNames.map((k) => `${k}=`),
            ``,
          ].join("\n");
          try {
            await writeFile(templatePath, body, { encoding: "utf-8", flag: "wx" });
            console.log(
              `  ${c.green}✓${c.reset} Generated ${templatePath}  ${c.dim}(${keyNames.length} keys)${c.reset}`,
            );
            fixedCount++;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  ${c.red}✗${c.reset} Failed to write ${templatePath}: ${msg}`);
            manualActions.push({
              blocker: `${templatePath} could not be created`,
              owner: "developer",
              reason: "local file permission / config",
              steps: [
                `Add ${keyNames.length} key placeholder(s).`,
                "Run `kit check --category secrets`.",
              ],
              respondWith: `${templatePath} exists; no secret values pasted`,
              agentContinuesWith: "kit check --category secrets",
            });
            manualCount++;
          }
        }
      } else {
        console.log(`${c.dim}No secrets template configured${c.reset}`);
      }
      console.log();

      // 5. Harden .gitignore — ensure .env*, *.pem, id_rsa, .kit/elevation.json
      //    are ignored. Idempotent: only appends what's missing.
      console.log(`${c.bold}[5/6] .gitignore${c.reset}`);
      try {
        const gitignorePath = resolve(cwd, ".gitignore");
        let current = "";
        try {
          current = await readFile(gitignorePath, "utf-8");
        } catch {
          current = "";
        }
        const required = [
          ".env",
          ".env.local",
          ".env.local.*",
          ".env.*.local",
          ".env.*.backup",
          "*.prod-backup",
          ".kit/elevation.json",
          ".kit-audit.jsonl",
          ".kit-audit.pending",
          ".kit-skipped-commits.jsonl",
        ];
        const lines = current.split("\n").map((l) => l.trim());
        const missing = required.filter((r) => !lines.includes(r));
        if (missing.length === 0) {
          console.log(`${c.dim}.gitignore already hardened${c.reset}`);
        } else {
          const appended =
            (current.endsWith("\n") || current === "" ? "" : "\n") +
            "\n# kit fix — secret-leak prevention\n" +
            missing.join("\n") +
            "\n";
          await writeFile(gitignorePath, current + appended, "utf-8");
          console.log(`  ${c.green}✓${c.reset} Added ${missing.length} pattern(s) to .gitignore`);
          for (const m of missing) {
            console.log(`     ${c.dim}+ ${m}${c.reset}`);
          }
          fixedCount++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ${c.red}✗${c.reset} .gitignore harden failed: ${msg}`);
        manualActions.push({
          blocker: ".gitignore could not be hardened",
          owner: "developer",
          reason: "local file permission / config",
          steps: ["Add .env*, *.pem, id_rsa, and kit local-state ignores.", "Run `kit check`."],
          respondWith: ".gitignore hardened",
          agentContinuesWith: "kit check",
        });
        manualCount++;
      }
      console.log();

      // 6. Install git hooks if configured but not present. Reuses cmdHooks's
      //    installHooks() — same bypass-detector pair lands too.
      console.log(`${c.bold}[6/6] Git Hooks${c.reset}`);
      if (config.hooks && Object.keys(config.hooks).length > 0) {
        try {
          const hookResults = await installHooks(config.hooks, ".git", cwd);
          const installed = hookResults.filter((r) => r.action === "installed");
          const updated = hookResults.filter((r) => r.action === "updated");
          const failed = hookResults.filter((r) => r.action === "failed");
          if (installed.length > 0) {
            console.log(
              `  ${c.green}✓${c.reset} Installed ${installed.length} hook(s): ${installed.map((r) => r.hookName).join(", ")}`,
            );
            fixedCount++;
          }
          if (updated.length > 0) {
            console.log(
              `  ${c.dim}↻ Updated ${updated.length} existing hook(s): ${updated.map((r) => r.hookName).join(", ")}${c.reset}`,
            );
          }
          if (failed.length > 0) {
            for (const f of failed) {
              console.log(`  ${c.red}✗${c.reset} ${f.hookName}: ${f.detail}`);
              manualActions.push({
                blocker: `${f.hookName} hook could not be installed`,
                owner: "developer",
                reason: "local git hook setup",
                steps: [f.detail, "Run `kit check --category hooks`."],
                respondWith: `${f.hookName} hook installed or intentionally skipped`,
                agentContinuesWith: "kit check --category hooks",
              });
              manualCount++;
            }
          }
          if (installed.length === 0 && updated.length === 0 && failed.length === 0) {
            console.log(`${c.dim}Hooks up to date${c.reset}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${c.red}✗${c.reset} Hooks install failed: ${msg}`);
          manualActions.push({
            blocker: "git hooks could not be installed",
            owner: "developer",
            reason: "local git hook setup",
            steps: [`Run \`kit hooks install\`.`, "Run `kit check --category hooks`."],
            respondWith: "git hooks installed or intentionally skipped",
            agentContinuesWith: "kit check --category hooks",
          });
          manualCount++;
        }
      } else {
        console.log(`${c.dim}No hooks configured in .kit.toml${c.reset}`);
      }
      console.log();

      const deployFix = await fixDeploy(config, cwd);
      fixedCount += deployFix.fixedCount;
      manualActions.push(...deployFix.manualActions);
      manualCount += deployFix.manualActions.length;

      // Summary
      console.log(`${c.bold}${c.cyan}Summary${c.reset}`);
      console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

      if (fixedCount > 0) {
        console.log(`  ${c.green}✓${c.reset} Fixed ${fixedCount} issue(s) automatically`);
      }

      if (manualCount > 0) {
        console.log(`  ${c.yellow}!${c.reset} ${manualCount} issue(s) require human action:\n`);
        console.log(formatHitlBlocks(manualActions));
        console.log();
        console.log(
          `${c.dim}Run ${c.reset}${c.bold}kit check${c.reset}${c.dim} to verify status after manual fixes${c.reset}`,
        );
      } else if (fixedCount === 0) {
        console.log(`  ${c.green}✓${c.reset} Nothing to fix — all checks passing`);
      }

      console.log();
      return manualCount === 0;
    },
    // Audit the fix in the tree being fixed, not in whatever directory the process sits in.
    { cwd },
  );
}
