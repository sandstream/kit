import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";

/**
 * Liveblocks Realtime Adapter
 *
 * Liveblocks provides presence, collaborative cursors, and realtime data for web apps.
 * Keys come from the Liveblocks dashboard — no programmatic key creation.
 *
 * Dashboard: https://liveblocks.io/dashboard
 * API reference: https://liveblocks.io/docs/api-reference/rest-api-endpoints
 */
export const liveblocksRealtimeAdapter: ServiceAdapter = {
  name: "liveblocks/realtime",
  description: "Liveblocks collaborative realtime (presence, cursors, multiplayer)",

  getRequiredTools(): string[] {
    return []; // API-based, no CLI needed
  },

  async check(context: AdapterContext): Promise<boolean> {
    const secret = context.existingEnv.LIVEBLOCKS_SECRET_KEY;
    return !!(secret && secret.startsWith("sk_"));
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const secretKey = context.existingEnv.LIVEBLOCKS_SECRET_KEY;
    const publicKey = context.existingEnv.NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY;

    // Already configured with both keys
    if (secretKey?.startsWith("sk_") && publicKey?.startsWith("pk_")) {
      return {
        success: true,
        message: "Liveblocks already configured — keys present in environment",
        secrets: {
          LIVEBLOCKS_SECRET_KEY: secretKey,
          NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY: publicKey,
        },
        config: { service: "liveblocks/realtime", existing: true },
      };
    }

    // Secret key present, public key absent — derive from secret key prefix convention
    if (secretKey?.startsWith("sk_")) {
      const derivedPublicKey = secretKey.replace(/^sk_/, "pk_");
      return {
        success: true,
        message:
          "Liveblocks secret key found — set NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY manually if needed",
        secrets: {
          LIVEBLOCKS_SECRET_KEY: secretKey,
          NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY: publicKey ?? derivedPublicKey,
        },
        config: { service: "liveblocks/realtime", existing: true },
      };
    }

    // No keys — return manual setup instructions
    return {
      success: false,
      error: "Missing LIVEBLOCKS_SECRET_KEY",
      message: [
        "Set the following before running kit add liveblocks/realtime:",
        "  1. Go to https://liveblocks.io/dashboard and create a project",
        "  2. Copy the secret key → LIVEBLOCKS_SECRET_KEY",
        "  3. Copy the public key → NEXT_PUBLIC_LIVEBLOCKS_PUBLIC_KEY",
        "  4. Export and re-run: kit add liveblocks/realtime",
      ].join("\n"),
    };
  },
};
