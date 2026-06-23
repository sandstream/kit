import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";

interface PlanetScaleDatabase {
  id: string;
  name: string;
  notes: string | null;
}

interface PlanetScalePassword {
  id: string;
  name: string;
  username: string;
  access_host_url: string;
  plain_text: string;
}

/**
 * PlanetScale MySQL Adapter
 *
 * Provisions a PlanetScale serverless MySQL database via the PlanetScale API.
 * Requires PLANETSCALE_SERVICE_TOKEN_ID + PLANETSCALE_SERVICE_TOKEN +
 * PLANETSCALE_ORG in the environment.
 *
 * API reference: https://api.planetscale.com/v1
 */
export const planetscaleDbAdapter: ServiceAdapter = {
  name: "planetscale/db",
  description: "PlanetScale serverless MySQL database",

  getRequiredTools(): string[] {
    return []; // API-based, no CLI needed
  },

  async check(context: AdapterContext): Promise<boolean> {
    const url = context.existingEnv.DATABASE_URL;
    return !!(url && url.startsWith("mysql://"));
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const tokenId = context.existingEnv.PLANETSCALE_SERVICE_TOKEN_ID;
    const token = context.existingEnv.PLANETSCALE_SERVICE_TOKEN;
    const org = context.existingEnv.PLANETSCALE_ORG;

    // Already configured — re-use
    if (context.existingEnv.DATABASE_URL?.startsWith("mysql://")) {
      return {
        success: true,
        message: "PlanetScale already configured — DATABASE_URL present in environment",
        secrets: buildSecrets(context.existingEnv),
        config: { service: "planetscale/db", existing: true },
      };
    }

    // Missing credentials
    if (!tokenId || !token || !org) {
      const missing = [
        !tokenId && "PLANETSCALE_SERVICE_TOKEN_ID",
        !token && "PLANETSCALE_SERVICE_TOKEN",
        !org && "PLANETSCALE_ORG",
      ].filter(Boolean);

      return {
        success: false,
        error: `Missing PlanetScale credentials: ${missing.join(", ")}`,
        message: [
          "Set the following before running kit add planetscale/db:",
          "  PLANETSCALE_ORG — your PlanetScale organization name",
          "  PLANETSCALE_SERVICE_TOKEN_ID — service token ID",
          "  PLANETSCALE_SERVICE_TOKEN — service token secret",
          "  Create a service token at: https://app.planetscale.com/<org>/settings/service-tokens",
        ].join("\n"),
      };
    }

    const dbName = context.projectName ?? context.projectPath.split("/").pop() ?? "kit-db";

    const headers = {
      Authorization: `${tokenId}:${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };

    // Create database
    let db: PlanetScaleDatabase;
    try {
      const resp = await fetch(`https://api.planetscale.com/v1/organizations/${org}/databases`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: dbName }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        return {
          success: false,
          error: `PlanetScale API error ${resp.status}: ${body}`,
          message: "Failed to create PlanetScale database",
        };
      }

      db = (await resp.json()) as PlanetScaleDatabase;
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Network error",
        message: "Failed to reach PlanetScale API",
      };
    }

    // Create a connection password for the main branch
    let password: PlanetScalePassword;
    try {
      const resp = await fetch(
        `https://api.planetscale.com/v1/organizations/${org}/databases/${db.name}/branches/main/passwords`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ name: `${dbName}-kit`, role: "readwriter" }),
        },
      );

      if (!resp.ok) {
        const body = await resp.text();
        return {
          success: false,
          error: `PlanetScale password API error ${resp.status}: ${body}`,
          message: "Database created but failed to generate connection password",
        };
      }

      password = (await resp.json()) as PlanetScalePassword;
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Network error",
        message: "Failed to create database connection password",
      };
    }

    const databaseUrl = `mysql://${password.username}:${password.plain_text}@${password.access_host_url}/${db.name}?ssl={"rejectUnauthorized":true}`;

    return {
      success: true,
      message: `PlanetScale database '${db.name}' created`,
      secrets: {
        DATABASE_URL: databaseUrl,
        PLANETSCALE_HOST: password.access_host_url,
        PLANETSCALE_USERNAME: password.username,
        PLANETSCALE_PASSWORD: password.plain_text,
      },
      config: { service: "planetscale/db", database: db.name, org },
    };
  },
};

function buildSecrets(env: Record<string, string>): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (env.DATABASE_URL) secrets.DATABASE_URL = env.DATABASE_URL;
  if (env.PLANETSCALE_HOST) secrets.PLANETSCALE_HOST = env.PLANETSCALE_HOST;
  if (env.PLANETSCALE_USERNAME) secrets.PLANETSCALE_USERNAME = env.PLANETSCALE_USERNAME;
  if (env.PLANETSCALE_PASSWORD) secrets.PLANETSCALE_PASSWORD = env.PLANETSCALE_PASSWORD;
  return secrets;
}
