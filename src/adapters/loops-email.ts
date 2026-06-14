import { apiKeyAdapter } from "./api-key-adapter.js";

/**
 * Loops — modern email marketing for SaaS (onboarding, newsletters, transactional).
 * No programmatic account creation; provisioning reuses an existing LOOPS_API_KEY.
 * API reference: https://loops.so/docs/api-reference
 */
export const loopsEmailAdapter = apiKeyAdapter({
  name: "loops/email",
  description: "Loops marketing and transactional email for SaaS",
  required: ["LOOPS_API_KEY"],
  steps: [
    "Set LOOPS_API_KEY before running kit add loops/email:",
    "  1. Go to https://app.loops.so/settings?page=api and create an API key",
    "  2. Export it: export LOOPS_API_KEY=<your-key>",
    "  3. Re-run: kit add loops/email",
  ],
});
