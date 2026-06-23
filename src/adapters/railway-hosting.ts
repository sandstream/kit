import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";
import { exec } from "../utils/exec.js";

async function runRailway(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec("railway", args, {
      cwd,
      timeout: 120_000,
      env: { ...process.env, ...env },
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

export const railwayHostingAdapter: ServiceAdapter = {
  name: "railway/hosting",
  description: "Railway — Heroku-style deployment platform (hosting provisioning)",

  getRequiredTools(): string[] {
    return ["railway"];
  },

  async check(context: AdapterContext): Promise<boolean> {
    const token = context.existingEnv["RAILWAY_TOKEN"];
    const projectId = context.existingEnv["RAILWAY_PROJECT_ID"];

    // If token exists, consider it configured
    if (token) return true;

    // Otherwise check if railway CLI is authenticated
    if (!projectId) return false;

    const { ok } = await runRailway(["status"], context.projectPath);
    return ok;
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    // Key-reuse: if we already have a project ID, return it
    const existingToken = context.existingEnv["RAILWAY_TOKEN"];
    const existingProjectId = context.existingEnv["RAILWAY_PROJECT_ID"];
    const existingEnvId = context.existingEnv["RAILWAY_ENVIRONMENT_ID"];

    if (existingToken && existingProjectId && existingEnvId) {
      return {
        success: true,
        message: "Railway project already configured",
        secrets: {
          RAILWAY_TOKEN: existingToken,
          RAILWAY_PROJECT_ID: existingProjectId,
          RAILWAY_ENVIRONMENT_ID: existingEnvId,
        },
      };
    }

    // Step 1: Check if railway CLI is installed and available
    const installCheckResult = await runRailway(["--version"], context.projectPath);
    if (!installCheckResult.ok) {
      return {
        success: false,
        message: "Railway CLI not found. Install with: npm install -g @railway/cli",
        error: "railway CLI not installed",
      };
    }

    // Step 2: Ensure user is logged in (browserless is not interactive)
    // In non-interactive mode, token should be set via RAILWAY_TOKEN env var
    const loginCheckResult = await runRailway(["whoami"], context.projectPath);
    if (!loginCheckResult.ok && !existingToken) {
      return {
        success: false,
        message: "Not authenticated with Railway. Login with: railway login",
        error: "not authenticated",
      };
    }

    // Step 3: Initialize Railway project if needed
    let initResult = await runRailway(["link"], context.projectPath);
    if (!initResult.ok) {
      // If link fails, try init
      initResult = await runRailway(["init", "--empty"], context.projectPath);
      if (!initResult.ok) {
        return {
          success: false,
          message: `Failed to initialize Railway project: ${initResult.stderr}`,
          error: "failed to init",
        };
      }
    }

    // Step 4: Extract project information
    const statusResult = await runRailway(["status"], context.projectPath);
    if (!statusResult.ok) {
      return {
        success: false,
        message: `Failed to get Railway project status: ${statusResult.stderr}`,
        error: "status failed",
      };
    }

    // Parse project ID from status output
    // Expected format includes: Project: <project-id>
    const projectMatch = statusResult.stdout.match(/Project:\s+(\w+)/);
    const projectId = projectMatch?.[1];

    if (!projectId) {
      return {
        success: false,
        message: "Could not extract Railway project ID from status",
        error: "project id not found",
      };
    }

    // Step 5: Get environment ID (default to 'production')
    const envMatch = statusResult.stdout.match(/Environment:\s+(\w+)/);
    const environmentId = envMatch?.[1] || "production";

    // Step 6: Ensure we have a token
    let token = existingToken;
    if (!token) {
      // Try to get token from railway
      const tokenResult = await runRailway(["token"], context.projectPath);
      if (tokenResult.ok) {
        token = tokenResult.stdout;
      } else {
        return {
          success: false,
          message: "Could not obtain Railway API token",
          error: "token not found",
        };
      }
    }

    return {
      success: true,
      message: `Railway project configured: ${projectId}`,
      secrets: {
        RAILWAY_TOKEN: token,
        RAILWAY_PROJECT_ID: projectId,
        RAILWAY_ENVIRONMENT_ID: environmentId,
      },
    };
  },
};
