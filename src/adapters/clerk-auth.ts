import { apiKeyAdapter } from "./api-key-adapter.js";

/**
 * Clerk — authentication and user management.
 * No programmatic app creation without an account API key, so provisioning
 * reuses both the secret and publishable keys or returns dashboard steps.
 */
export const clerkAuthAdapter = apiKeyAdapter({
  name: "clerk/auth",
  description: "Clerk authentication and user management",
  required: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
  steps: [
    "Clerk requires manual key retrieval from the dashboard.",
    "1. Go to https://dashboard.clerk.com and create a new application",
    "2. Copy 'Publishable key' → NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    "3. Copy 'Secret keys' → CLERK_SECRET_KEY",
    "4. Optionally copy webhook secret → CLERK_WEBHOOK_SECRET",
    "5. Re-run: kit add clerk/auth (or kit secrets) to write the keys",
  ],
});
