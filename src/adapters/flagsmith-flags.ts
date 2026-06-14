import { apiKeyAdapter } from "./api-key-adapter.js";

/**
 * Flagsmith — feature flags and remote config (SaaS or self-hosted).
 * API-based; reuses FLAGSMITH_ENVIRONMENT_KEY and carries an optional API URL.
 */
export const flagsmithFlagsAdapter = apiKeyAdapter({
  name: "flagsmith/flags",
  description: "Flagsmith feature flags and remote config (SaaS or self-hosted)",
  required: ["FLAGSMITH_ENVIRONMENT_KEY"],
  optional: [{ env: "FLAGSMITH_API_URL", default: "https://edge.api.flagsmith.com/api/v1/" }],
  steps: [
    "Set FLAGSMITH_ENVIRONMENT_KEY before running kit add flagsmith/flags:",
    "  1. Go to https://app.flagsmith.com and create a project and environment",
    "  2. Navigate to SDK Keys → copy the Client-Side environment key",
    "  3. Export it: export FLAGSMITH_ENVIRONMENT_KEY=<your-key>",
    "  4. Re-run: kit add flagsmith/flags",
    "  (Self-hosted: also set FLAGSMITH_API_URL to your instance URL)",
  ],
});
