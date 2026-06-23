import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";

interface NeonProject {
  id: string;
  name: string;
}

interface NeonConnectionUri {
  connection_uri: string;
}

interface NeonProjectResponse {
  project: NeonProject;
  connection_uris: NeonConnectionUri[];
}

/**
 * Neon Serverless Postgres Adapter
 *
 * Provisions a Neon serverless Postgres project via the Neon REST API.
 * Requires NEON_API_KEY in the environment.
 *
 * API reference: https://api.neon.tech/v2
 */
export const neonDbAdapter: ServiceAdapter = {
  name: "neon/db",
  description: "Neon serverless Postgres database",

  getRequiredTools(): string[] {
    return []; // API-based, no CLI needed
  },

  async check(context: AdapterContext): Promise<boolean> {
    const url = context.existingEnv.DATABASE_URL;
    return !!(url && (url.startsWith("postgres://") || url.startsWith("postgresql://")));
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const databaseUrl = context.existingEnv.DATABASE_URL;

    // Already configured — re-use
    if (
      databaseUrl &&
      (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://"))
    ) {
      return {
        success: true,
        message: "Neon (or Postgres) already configured — DATABASE_URL present in environment",
        secrets: {
          DATABASE_URL: databaseUrl,
          NEON_DATABASE_URL: databaseUrl,
        },
        config: { service: "neon/db", existing: true },
      };
    }

    const apiKey = context.existingEnv.NEON_API_KEY;

    if (!apiKey) {
      return {
        success: false,
        error: "Missing NEON_API_KEY",
        message: [
          "Set NEON_API_KEY before running kit add neon/db:",
          "  1. Go to https://console.neon.tech/app/settings/api-keys and create an API key",
          "  2. Export it: export NEON_API_KEY=<your-key>",
          "  3. Re-run: kit add neon/db",
        ].join("\n"),
      };
    }

    const projectName = context.projectName ?? context.projectPath.split("/").pop() ?? "kit-db";

    let project: NeonProjectResponse;
    try {
      const resp = await fetch("https://api.neon.tech/v2/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ project: { name: projectName } }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        return {
          success: false,
          error: `Neon API error ${resp.status}: ${body}`,
          message: "Failed to create Neon project",
        };
      }

      project = (await resp.json()) as NeonProjectResponse;
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Network error",
        message: "Failed to reach Neon API",
      };
    }

    const connectionUri = project.connection_uris?.[0]?.connection_uri;

    if (!connectionUri) {
      return {
        success: false,
        error: "Neon project created but no connection URI returned",
        message: `Project '${projectName}' created (id: ${project.project.id}) but connection URI was empty`,
      };
    }

    return {
      success: true,
      message: `Neon project '${projectName}' created`,
      secrets: {
        DATABASE_URL: connectionUri,
        NEON_DATABASE_URL: connectionUri,
      },
      config: { service: "neon/db", projectId: project.project.id, name: projectName },
    };
  },
};
