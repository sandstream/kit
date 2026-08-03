import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";

/**
 * Resend Email Adapter
 *
 * Provisions a project-scoped Resend API key for transactional email.
 * Requires a master RESEND_API_KEY in the environment (from the Resend dashboard).
 *
 * API reference: https://resend.com/docs/api-reference/api-keys/create-api-key
 */
export const resendEmailAdapter: ServiceAdapter = {
  name: "resend/email",
  description: "Resend transactional email API with project-scoped key",

  getRequiredTools(): string[] {
    return []; // API-based, no CLI needed
  },

  async check(context: AdapterContext): Promise<boolean> {
    const key = context.existingEnv.RESEND_API_KEY;
    return !!(key && key.startsWith("re_"));
  },

  async provision(context: AdapterContext): Promise<ProvisionResult> {
    const masterKey = context.existingEnv.RESEND_API_KEY;

    // If a valid key is already set, re-use it
    if (masterKey && masterKey.startsWith("re_")) {
      const fromEmail = context.existingEnv.RESEND_FROM_EMAIL ?? "onboarding@resend.dev";
      return {
        success: true,
        message: "Resend already configured — API key present in environment",
        secrets: {
          RESEND_API_KEY: masterKey,
          RESEND_FROM_EMAIL: fromEmail,
        },
        config: { service: "resend/email", existing: true },
      };
    }

    // No key at all → guide the user to get one
    if (!masterKey) {
      return {
        success: false,
        error: "Missing RESEND_API_KEY",
        message: [
          "Set RESEND_API_KEY before running kit add resend/email:",
          "  1. Go to https://resend.com/api-keys and create an API key",
          "  2. Export it: export RESEND_API_KEY=re_...",
          "  3. Re-run: kit add resend/email",
        ].join("\n"),
      };
    }

    // We have a key but it doesn't look valid — treat it the same way
    return {
      success: false,
      error: `RESEND_API_KEY does not look valid (expected prefix 're_', got: '${masterKey.slice(0, 6)}...')`,
      message: "Check your RESEND_API_KEY — it should start with 're_'",
    };
  },
};
