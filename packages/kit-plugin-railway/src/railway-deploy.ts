import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";

const exec = promisify(execFile);

async function runRailway(
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec("railway", args, {
      cwd,
      timeout: 60_000,
      env: { ...process.env },
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout?.trim() ?? "",
      stderr: (e.stderr ?? e.message ?? String(err)).trim(),
    };
  }
}

export const railwayDeployAdapter: ServiceAdapter = {
  name: "railway/deploy",
  description: "Railway — Heroku-style deployment platform",

  getRequiredTools(): string[] {
    return ["railway"];
  },

  async check(context: AdapterContext): Promise<boolean> {
    const projectId = context.existingEnv["RAILWAY_PROJECT_ID"];
    if (!projectId) return false;

    // Verify the CLI is linked to a project in this directory
    const { ok } = await runRailway(["status"], context.projectPath);
    return ok;
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    // Key-reuse: already have project ID
    const existingProjectId = context.existingEnv["RAILWAY_PROJECT_ID"];
    if (existingProjectId) {
      return {
        success: true,
        message: "Railway project already configured",
        secrets: {
          RAILWAY_PROJECT_ID: existingProjectId,
          RAILWAY_ENVIRONMENT: context.existingEnv["RAILWAY_ENVIRONMENT"] ?? "production",
        },
      };
    }

    // Step 1: authenticate (browserless for non-interactive / agent use)
    const login = await runRailway(["login", "--browserless"], context.projectPath);
    if (!login.ok && !login.stderr.includes("Already logged in")) {
      return {
        success: false,
        error: "Railway login failed",
        message: [
          "Could not authenticate with Railway.",
          "Run `railway login` manually, then retry.",
          login.stderr,
        ].join("\n"),
      };
    }

    // Step 2: initialise project
    const projectName = context.projectName ?? "my-app";
    const init = await runRailway(["init", "--name", projectName], context.projectPath);
    if (!init.ok) {
      return {
        success: false,
        error: "railway init failed",
        message: init.stderr || init.stdout,
      };
    }

    // Step 3: get project ID from status output
    const status = await runRailway(["status", "--json"], context.projectPath);
    let projectId = "";
    let environment = "production";
    if (status.ok) {
      try {
        const parsed = JSON.parse(status.stdout) as Record<string, unknown>;
        projectId = String(parsed["projectId"] ?? "");
        environment = String(parsed["environment"] ?? "production");
      } catch {
        // status output isn't JSON — use a placeholder; user can correct later
      }
    }

    return {
      success: true,
      message: `Railway project "${projectName}" initialised`,
      secrets: {
        ...(projectId ? { RAILWAY_PROJECT_ID: projectId } : {}),
        RAILWAY_ENVIRONMENT: environment,
      },
    };
  },
};
