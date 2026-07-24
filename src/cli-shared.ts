// Shared CLI helpers, extracted from cli.ts so command modules can import them
// without a circular dependency back through the entrypoint. Step 1 of splitting
// the (large) cli.ts into per-area command modules under src/commands/.
import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { kitConfig } from "./config.js";
import type { HealthCtx } from "./health.js";

/** The project config file name. */
export const KIT_FILE = ".kit.toml";

/** Absolute path to the project's .kit.toml in the current working directory. */
export function resolveConfigPath(): string {
  return resolve(process.cwd(), KIT_FILE);
}

/**
 * Build the runtime context the health sensors + sentinel consume: git remote
 * presence, CI host files, Vercel linkage, and detected services. Co-owned by
 * `kit health` (cmdHealth, in cli.ts) and `kit sentinel` (commands/sentinel.ts),
 * so it lives here in the neutral seam rather than in either command module.
 */
export async function buildHealthCtx(config: kitConfig): Promise<HealthCtx> {
  const { execFileNoThrow } = await import("./utils/execFileNoThrow.js");
  const remote = await execFileNoThrow("git", ["remote"], { timeout: 5_000 });
  const cwd = process.cwd();
  let vercel: { orgId?: string; projectId?: string } | undefined;
  try {
    const vj = JSON.parse(readFileSync(resolve(cwd, ".vercel", "project.json"), "utf8")) as {
      orgId?: string;
      projectId?: string;
    };
    if (vj.projectId) vercel = { orgId: vj.orgId, projectId: vj.projectId };
  } catch {
    vercel = undefined;
  }
  let services: string[];
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const { detectServices } = await import("./service-registry.js");
    services = await detectServices({ deps, fileExists: async (p) => existsSync(resolve(cwd, p)) });
  } catch {
    services = [];
  }
  return {
    cwd,
    config,
    gitRemote: remote.ok && remote.stdout.trim().length > 0,
    gitlabCi: existsSync(resolve(cwd, ".gitlab-ci.yml")),
    bitbucketPipelines: existsSync(resolve(cwd, "bitbucket-pipelines.yml")),
    vercel,
    services,
  };
}
