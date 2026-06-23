import type { ServiceAdapter, AdapterContext, ProvisionResult } from "./types.js";

interface ResendApiKey {
  id: string;
  token: string;
}

interface ResendDomain {
  id: string;
  name: string;
  status: string;
}

interface ResendDomainsResponse {
  data: ResendDomain[];
}

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

/**
 * Resend Email Provisioner — creates a scoped API key via the Resend API.
 *
 * Called by resendEmailAdapter.provision() when a master key is available
 * and we want to create a project-scoped key instead of reusing the master.
 *
 * Exported separately so it can be tested without stubbing the adapter.
 */
export async function provisionResendApiKey(
  masterKey: string,
  keyName: string,
): Promise<{ success: true; key: ResendApiKey } | { success: false; error: string }> {
  try {
    const resp = await fetch("https://api.resend.com/api-keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${masterKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: keyName, permission: "sending_access" }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      return {
        success: false,
        error: `Resend API error ${resp.status}: ${body}`,
      };
    }

    const key = (await resp.json()) as ResendApiKey;
    return { success: true, key };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Network error",
    };
  }
}

/**
 * Fetch the first verified sending domain for the account.
 * Returns null if none exist (use onboarding@resend.dev as fallback).
 */
export async function fetchFirstVerifiedDomain(apiKey: string): Promise<string | null> {
  try {
    const resp = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as ResendDomainsResponse;
    const verified = data.data?.find((d) => d.status === "verified");
    return verified ? verified.name : null;
  } catch {
    return null;
  }
}
