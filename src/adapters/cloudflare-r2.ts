import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";
import { exec } from "../utils/exec.js";


/**
 * Cloudflare R2 Object Storage Adapter
 * Provisions an R2 bucket and writes S3-compatible credentials
 */
export const cloudflareR2Adapter: ServiceAdapter = {
  name: "cloudflare/r2",
  description: "Cloudflare R2 object storage (S3-compatible)",

  getRequiredTools(): string[] {
    return ["wrangler"];
  },

  async check(context: AdapterContext): Promise<boolean> {
    return !!(
      context.existingEnv.R2_ACCESS_KEY_ID &&
      context.existingEnv.R2_SECRET_ACCESS_KEY &&
      context.existingEnv.R2_BUCKET_NAME
    );
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    // Check wrangler CLI
    try {
      await exec("wrangler", ["--version"], { timeout: 5_000 });
    } catch {
      return {
        success: false,
        error: "Wrangler CLI not installed",
        message: "Install Wrangler: npm install -g wrangler",
      };
    }

    // Check authentication
    const accountId = context.existingEnv.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) {
      return {
        success: false,
        error: "CLOUDFLARE_ACCOUNT_ID not set",
        message: [
          "Set CLOUDFLARE_ACCOUNT_ID in your environment, then re-run.",
          "Find it at: https://dash.cloudflare.com (right sidebar)",
        ].join("\n"),
      };
    }

    // Return existing if already configured
    if (
      context.existingEnv.R2_ACCESS_KEY_ID &&
      context.existingEnv.R2_SECRET_ACCESS_KEY
    ) {
      return {
        success: true,
        message: "Cloudflare R2 already configured — keys present in environment",
        secrets: {
          R2_ACCESS_KEY_ID: context.existingEnv.R2_ACCESS_KEY_ID,
          R2_SECRET_ACCESS_KEY: context.existingEnv.R2_SECRET_ACCESS_KEY,
          R2_BUCKET_NAME: context.existingEnv.R2_BUCKET_NAME ?? "",
          R2_ENDPOINT: context.existingEnv.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`,
          CLOUDFLARE_ACCOUNT_ID: accountId,
        },
        config: { service: "cloudflare/r2", existing: true },
      };
    }

    const bucketName = (
      context.projectName ?? context.projectPath.split("/").pop() ?? "kit-bucket"
    )
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    // Create bucket
    try {
      await exec("wrangler", ["r2", "bucket", "create", bucketName], {
        timeout: 30_000,
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Bucket may already exist — that's fine
      if (!msg.includes("already exists")) {
        return {
          success: false,
          error: msg,
          message: "Failed to create R2 bucket",
        };
      }
    }

    const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

    // R2 API tokens must be created via the Cloudflare dashboard or REST API
    // (wrangler does not expose token creation). Return what we can + manual steps.
    const cfApiToken = context.existingEnv.CF_API_TOKEN;
    if (cfApiToken) {
      // Try to create R2 API token via Cloudflare API
      try {
        const resp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/tokens`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cfApiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: `${bucketName}-kit`,
              permissions: ["admin:read", "admin:write"],
              buckets: [bucketName],
            }),
          }
        );

        if (resp.ok) {
          const data = (await resp.json()) as {
            result: { accessKeyId: string; secretAccessKey: string };
          };
          const { accessKeyId, secretAccessKey } = data.result;

          return {
            success: true,
            message: `R2 bucket '${bucketName}' created with API token`,
            secrets: {
              R2_ACCESS_KEY_ID: accessKeyId,
              R2_SECRET_ACCESS_KEY: secretAccessKey,
              R2_BUCKET_NAME: bucketName,
              R2_ENDPOINT: endpoint,
              CLOUDFLARE_ACCOUNT_ID: accountId,
            },
            config: { service: "cloudflare/r2", bucketName, accountId },
          };
        }
      } catch {
        // Fall through to manual steps
      }
    }

    // Return bucket created + manual steps for API token
    return {
      success: true,
      message: [
        `R2 bucket '${bucketName}' created.`,
        "To get R2 API credentials (Access Key ID + Secret), create an API token manually:",
        `  https://dash.cloudflare.com/${accountId}/r2/api-tokens`,
        "Then set R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT in your environment.",
      ].join("\n"),
      secrets: {
        R2_BUCKET_NAME: bucketName,
        R2_ENDPOINT: endpoint,
        CLOUDFLARE_ACCOUNT_ID: accountId,
      },
      config: { service: "cloudflare/r2", bucketName, accountId, tokenRequired: true },
    };
  },
};
