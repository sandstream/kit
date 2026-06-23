import type { ServiceAdapter, AdapterContext, ProvisionResult } from "sandstream-kit-adapter-sdk";
import { exec } from "../utils/exec.js";

async function runFly(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec("fly", args, {
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

export const flyioHostingAdapter: ServiceAdapter = {
  name: "flyio/hosting",
  description: "Fly.io — Container deployment platform",

  getRequiredTools(): string[] {
    return ["fly"];
  },

  async check(context: AdapterContext): Promise<boolean> {
    const token = context.existingEnv["FLY_API_TOKEN"];
    const appName = context.existingEnv["FLY_APP_NAME"];

    // If token and app name exist, consider it configured
    if (token && appName) return true;

    // Otherwise check if fly CLI is authenticated
    const { ok } = await runFly(["auth", "whoami"], context.projectPath);
    return ok;
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    // Key-reuse: if we already have credentials, return them
    const existingToken = context.existingEnv["FLY_API_TOKEN"];
    const existingAppName = context.existingEnv["FLY_APP_NAME"];
    const existingOrgSlug = context.existingEnv["FLY_ORG_SLUG"];

    if (existingToken && existingAppName && existingOrgSlug) {
      return {
        success: true,
        message: "Fly.io app already configured",
        secrets: {
          FLY_API_TOKEN: existingToken,
          FLY_APP_NAME: existingAppName,
          FLY_ORG_SLUG: existingOrgSlug,
        },
      };
    }

    // Step 1: Check if fly CLI is installed and available
    const versionResult = await runFly(["version"], context.projectPath);
    if (!versionResult.ok) {
      return {
        success: false,
        message: "Fly CLI (flyctl) not found. Install with: brew install flyctl",
        error: "fly CLI not installed",
      };
    }

    // Step 2: Ensure user is authenticated
    // In headless mode, token should be set via FLY_API_TOKEN env var or via fly auth login --access-token
    const whoamiResult = await runFly(["auth", "whoami"], context.projectPath);
    if (!whoamiResult.ok && !existingToken) {
      return {
        success: false,
        message: "Not authenticated with Fly.io. Login with: fly auth login",
        error: "not authenticated",
      };
    }

    // Step 3: Create a new app if needed
    // Parse project name from package.json or use directory name
    let appName = existingAppName;
    if (!appName) {
      // Generate app name from project name or use a default
      const projectName = context.projectName || "kit-app";
      appName = projectName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .substring(0, 30);

      // Create the app
      const createResult = await runFly(["apps", "create", appName], context.projectPath);
      if (!createResult.ok) {
        // App might already exist, that's fine
        if (!createResult.stderr.includes("already exists")) {
          return {
            success: false,
            message: `Failed to create Fly.io app: ${createResult.stderr}`,
            error: "failed to create app",
          };
        }
      }
    }

    // Step 4: Get organization slug
    let orgSlug = existingOrgSlug;
    if (!orgSlug) {
      const statusResult = await runFly(["status", "-a", appName], context.projectPath);
      if (statusResult.ok) {
        // Try to extract org from status output
        // Expected format includes: Organization: <org-slug>
        const orgMatch = statusResult.stdout.match(/Organization:\s+(\S+)/);
        orgSlug = orgMatch?.[1] || "personal";
      } else {
        orgSlug = "personal";
      }
    }

    // Step 5: Get or create API token
    let token = existingToken;
    if (!token) {
      // Create a deploy token
      const tokenResult = await runFly(
        ["tokens", "create", "deploy", "-x", "720h"],
        context.projectPath,
      );
      if (tokenResult.ok) {
        // Extract token from output
        // Expected format: Token: <token-value>
        const match = tokenResult.stdout.match(/Token:\s+(\S+)/);
        token = match?.[1] || "";

        if (!token) {
          return {
            success: false,
            message: "Could not parse Fly.io API token",
            error: "failed to parse token",
          };
        }
      } else {
        // Fall back to reading current token
        return {
          success: false,
          message: "Could not create Fly.io deploy token",
          error: "failed to create token",
        };
      }
    }

    return {
      success: true,
      message: `Fly.io app configured: ${appName}`,
      secrets: {
        FLY_API_TOKEN: token,
        FLY_APP_NAME: appName,
        FLY_ORG_SLUG: orgSlug,
      },
    };
  },
};
