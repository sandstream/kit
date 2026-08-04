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
import { loadConfig } from "./config.js";
import { withGovernance } from "./governance-middleware.js";
import { checkTools } from "./check-tools.js";
import { checkServices } from "./check-services.js";
import { installHooks } from "./hooks.js";
import { c } from "./utils/colors.js";

export interface FixResult {
  category: "tool" | "service" | "lock" | "secret";
  name: string;
  action: "fixed" | "already_ok" | "needs_manual" | "failed";
  detail: string;
}

/**
 * `kit fix` — auto-remediation pipeline. Six steps: install missing
 * tools, generate lock files, surface unauthenticated services, generate
 * .env.template, harden .gitignore, install git hooks. Returns false when
 * any step requires manual intervention.
 *
 * Extracted from cli.ts (codebase-review follow-up).
 */
export async function cmdFix(cwd: string = process.cwd()): Promise<boolean> {
  console.log(`${c.bold}${c.cyan}kit fix${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  const config = await loadConfig(resolve(cwd, ".kit.toml"));

  let fixedCount = 0;
  let manualCount = 0;
  const manualActions: string[] = [];

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
              manualActions.push(`Install ${r.name} manually: ${r.detail}`);
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
            const loginCmd = config.services[s.name]?.login ?? "";
            if (loginCmd.trim().startsWith("#")) {
              // Informational ("#"-prefixed) login — no CLI to run, only docs.
              manualActions.push(`${s.name}: ${loginCmd.trim().replace(/^#\s*/, "")}`);
            } else {
              manualActions.push(`Login to ${s.name}: run 'kit login' or '${loginCmd}'`);
            }
            manualCount++;
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
            manualActions.push(`Create ${templatePath} manually with ${keyNames.length} keys`);
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
        manualActions.push("Harden .gitignore manually (.env*, *.pem, id_rsa)");
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
              manualActions.push(`Install ${f.hookName} hook manually`);
              manualCount++;
            }
          }
          if (installed.length === 0 && updated.length === 0 && failed.length === 0) {
            console.log(`${c.dim}Hooks up to date${c.reset}`);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${c.red}✗${c.reset} Hooks install failed: ${msg}`);
          manualActions.push("Run 'kit hooks install' manually");
          manualCount++;
        }
      } else {
        console.log(`${c.dim}No hooks configured in .kit.toml${c.reset}`);
      }
      console.log();

      // Summary
      console.log(`${c.bold}${c.cyan}Summary${c.reset}`);
      console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

      if (fixedCount > 0) {
        console.log(`  ${c.green}✓${c.reset} Fixed ${fixedCount} issue(s) automatically`);
      }

      if (manualCount > 0) {
        console.log(
          `  ${c.yellow}!${c.reset} ${manualCount} issue(s) require manual intervention:\n`,
        );
        for (const action of manualActions) {
          console.log(`     ${c.dim}•${c.reset} ${action}`);
        }
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
