import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";

interface UpstashDatabase {
  database_id: string;
  database_name: string;
  endpoint: string;
  rest_token: string;
  read_only_rest_token: string;
}

/**
 * Upstash Redis Adapter
 * Provisions a serverless Redis database via the Upstash REST API
 */
export const upstashRedisAdapter: ServiceAdapter = {
  name: "upstash/redis",
  description: "Upstash serverless Redis database",

  getRequiredTools(): string[] {
    return []; // API-based, no CLI needed
  },

  async check(context: AdapterContext): Promise<boolean> {
    return !!(
      context.existingEnv.UPSTASH_REDIS_REST_URL &&
      context.existingEnv.UPSTASH_REDIS_REST_TOKEN
    );
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const email = context.existingEnv.UPSTASH_EMAIL;
    const apiKey = context.existingEnv.UPSTASH_API_KEY;

    if (!email || !apiKey) {
      return {
        success: false,
        error: "Missing Upstash credentials",
        message: [
          "Set the following environment variables before running kit add upstash/redis:",
          "  UPSTASH_EMAIL — your Upstash account email",
          "  UPSTASH_API_KEY — your Upstash API key (https://console.upstash.com/account/api)",
        ].join("\n"),
      };
    }

    // Return existing if already configured
    if (
      context.existingEnv.UPSTASH_REDIS_REST_URL &&
      context.existingEnv.UPSTASH_REDIS_REST_TOKEN
    ) {
      return {
        success: true,
        message: "Upstash Redis already configured — keys present in environment",
        secrets: {
          UPSTASH_REDIS_REST_URL: context.existingEnv.UPSTASH_REDIS_REST_URL,
          UPSTASH_REDIS_REST_TOKEN: context.existingEnv.UPSTASH_REDIS_REST_TOKEN,
        },
        config: { service: "upstash/redis", existing: true },
      };
    }

    const dbName =
      context.projectName ?? context.projectPath.split("/").pop() ?? "kit-redis";

    const auth = Buffer.from(`${email}:${apiKey}`).toString("base64");

    // Create database
    let db: UpstashDatabase;
    try {
      const resp = await fetch("https://api.upstash.com/v2/redis/database", {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: dbName, region: "us-east-1", tls: true }),
      });

      if (!resp.ok) {
        const body = await resp.text();
        return {
          success: false,
          error: `Upstash API error ${resp.status}: ${body}`,
          message: "Failed to create Upstash Redis database",
        };
      }

      db = (await resp.json()) as UpstashDatabase;
    } catch (error: unknown) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Network error",
        message: "Failed to reach Upstash API",
      };
    }

    const restUrl = `https://${db.endpoint}`;

    return {
      success: true,
      message: `Upstash Redis database '${dbName}' created`,
      secrets: {
        UPSTASH_REDIS_REST_URL: restUrl,
        UPSTASH_REDIS_REST_TOKEN: db.rest_token,
        KV_URL: restUrl,
        KV_REST_API_URL: restUrl,
        KV_REST_API_TOKEN: db.rest_token,
        KV_REST_API_READ_ONLY_TOKEN: db.read_only_rest_token,
      },
      config: { service: "upstash/redis", databaseId: db.database_id, name: dbName },
    };
  },
};
