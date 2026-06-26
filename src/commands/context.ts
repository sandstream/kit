// `kit context` commands — extracted from cli.ts (incremental split).
import { loadConfig } from "../config.js";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { resolveConfigPath } from "../cli-shared.js";
import {
  checkContext,
  applyContext,
  contextPrompt,
  gatherLive,
  suggestContextToml,
} from "../context-lock.js";
import { gatherProjectContext } from "../context.js";

async function cmdContextCheck(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const config = await loadConfig(resolveConfigPath());
  const findings = await checkContext(config.context);

  if (jsonMode) {
    console.log(JSON.stringify(findings, null, 2));
    return findings.every((f) => f.status !== "mismatch");
  }
  if (!config.context) {
    console.log(
      `${c.dim}No [context] declared in .kit.toml — each CLI is unlocked from its account + project.${c.reset}`,
    );
    const suggestion = suggestContextToml(await gatherLive(process.cwd()));
    if (suggestion) {
      console.log(
        `\nDetected here — add a ${c.bold}[context]${c.reset} block to .kit.toml to lock it:\n`,
      );
      console.log(suggestion);
      console.log(
        `\n${c.yellow}Verify each value is correct for THIS repo before trusting it.${c.reset} ${c.dim}kit detected the currently-active CLI state, which is exactly what the lock exists to question. Then re-run kit context check.${c.reset}`,
      );
    } else {
      console.log(
        `${c.dim}Add one to lock each CLI to its account + project (gcloud/vercel/github/git/npm).${c.reset}`,
      );
    }
    return true;
  }
  console.log(`${c.bold}Context lock${c.reset}\n`);
  for (const f of findings) {
    const icon =
      f.status === "ok"
        ? `${c.green}✓${c.reset}`
        : f.status === "mismatch"
          ? `${c.red}✗${c.reset}`
          : `${c.yellow}!${c.reset}`;
    const actual = f.actual ?? `${c.dim}(unreadable)${c.reset}`;
    const detail =
      f.status === "ok"
        ? `${c.dim}${f.expected}${c.reset}`
        : `expected ${c.bold}${f.expected}${c.reset}, live ${c.bold}${actual}${c.reset}`;
    console.log(`  ${icon} ${f.tool}.${f.field}  ${detail}`);
  }
  const mismatches = findings.filter((f) => f.status === "mismatch");
  if (mismatches.length > 0) {
    console.log(
      `\n${c.red}${mismatches.length} mismatch(es) — you are NOT locked to the declared account/project. Do not run outward/destructive commands until this is green.${c.reset}`,
    );
  }
  // Mismatch = non-zero exit so this can gate a hook / agent before acting.
  // Unknown (tool absent / unreadable) does not block.
  return mismatches.length === 0;
}

async function cmdContextUse(): Promise<boolean> {
  const config = await loadConfig(resolveConfigPath());
  if (!config.context) {
    console.log(
      `${c.dim}No [context] declared in .kit.toml. Add one to lock each CLI to its account + project.${c.reset}`,
    );
    return true;
  }
  console.log(`${c.bold}Context use${c.reset}\n`);
  const results = await applyContext(config.context, process.cwd());
  for (const r of results) {
    const icon = r.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(`  ${icon} ${r.step.tool}  ${c.dim}${r.step.describe}${c.reset}`);
  }
  // vercel/npm have no clean per-repo "active" state to switch — guide instead.
  if (config.context.vercel) {
    console.log(
      `  ${c.dim}vercel: pass --scope per command or run \`vercel link\`; kit does not switch the dashboard link.${c.reset}`,
    );
  }
  if (config.context.npm) {
    console.log(
      `  ${c.dim}npm: registry is global — set with \`npm config set registry <url>\` if it differs.${c.reset}`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  if (failed > 0) {
    console.log(
      `\n${c.yellow}${failed} step(s) failed (tool not installed?). Run kit context check to verify.${c.reset}`,
    );
  }
  return failed === 0;
}

export async function cmdContext(): Promise<boolean> {
  if (process.argv[3] === "check") return cmdContextCheck();
  if (process.argv[3] === "use") return cmdContextUse();
  // Fast, read-only PS1 indicator: `kit context --prompt` -> "[gcp:<project>]".
  if (hasFlag(process.argv, "--prompt")) {
    console.log(contextPrompt());
    return true;
  }

  const jsonMode = hasFlag(process.argv, "--json");

  try {
    const config = await loadConfig(resolveConfigPath());
    const context = await gatherProjectContext(config, process.cwd());

    if (jsonMode) {
      console.log(JSON.stringify(context, null, 2));
    } else {
      // Human-readable format
      console.log(`${c.bold}Project Context${c.reset}\n`);

      console.log(`${c.bold}Project: ${c.reset}${context.projectName}`);
      console.log(`${c.bold}kit Version: ${c.reset}${context.kitVersion}`);
      console.log(`${c.bold}Active Environment: ${c.reset}${context.activeEnvironment}`);
      console.log();

      if (context.detectedStack && Object.keys(context.detectedStack).length > 0) {
        console.log(`${c.bold}Detected Stack:${c.reset}`);
        for (const [key, value] of Object.entries(context.detectedStack)) {
          console.log(`  ${key}: ${value}`);
        }
        console.log();
      }

      if (context.tools.length > 0) {
        console.log(
          `${c.bold}Tools (${context.tools.filter((t) => t.ok).length}/${context.tools.length}):${c.reset}`,
        );
        for (const tool of context.tools) {
          const status = tool.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
          const version = tool.installed
            ? ` ${c.dim}(${tool.installed})${c.reset}`
            : " not installed";
          console.log(`  ${status} ${tool.name}${version}`);
        }
        console.log();
      }

      if (context.services.length > 0) {
        console.log(
          `${c.bold}Services (${context.services.filter((s) => s.authenticated).length}/${context.services.length}):${c.reset}`,
        );
        for (const service of context.services) {
          const status = service.authenticated ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
          console.log(`  ${status} ${service.name}`);
        }
        console.log();
      }

      if (context.secrets.keys.length > 0) {
        console.log(
          `${c.bold}Secrets (${context.secrets.keys.filter((s) => s.available).length}/${context.secrets.keys.length}):${c.reset}`,
        );
        for (const secret of context.secrets.keys) {
          const status = secret.available ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
          console.log(`  ${status} ${secret.name}`);
        }
        console.log();
      }

      if (context.locks.length > 0) {
        const allInSync = context.locks.every((l) => l.inSync);
        console.log(
          `${c.bold}Lock Files${allInSync ? ` ${c.green}(in sync)` : ` ${c.yellow}(drift detected)`}:${c.reset}`,
        );
        for (const lock of context.locks) {
          const status = lock.inSync ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
          console.log(`  ${status} ${lock.category}: ${lock.detail}`);
        }
      }
    }

    return true;
  } catch (err) {
    console.error(`${c.red}Error: ${(err as Error).message}${c.reset}`);
    return false;
  }
}
