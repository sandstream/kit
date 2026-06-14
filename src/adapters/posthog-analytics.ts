import { apiKeyAdapter } from "./api-key-adapter.js";

/**
 * PostHog — product analytics, session recording, feature flags.
 * API-based; reuses NEXT_PUBLIC_POSTHOG_KEY and carries an optional host
 * (defaults to US cloud; override for EU cloud / self-hosted).
 */
export const posthogAnalyticsAdapter = apiKeyAdapter({
  name: "posthog/analytics",
  description: "PostHog product analytics, session recording, and feature flags",
  required: ["NEXT_PUBLIC_POSTHOG_KEY"],
  optional: [{ env: "NEXT_PUBLIC_POSTHOG_HOST", default: "https://us.i.posthog.com" }],
  steps: [
    "Set NEXT_PUBLIC_POSTHOG_KEY before running kit add posthog/analytics:",
    "  1. Go to https://app.posthog.com and create a project",
    "  2. Navigate to Settings → Project API key",
    "  3. Export: export NEXT_PUBLIC_POSTHOG_KEY=phc_...",
    "  4. Re-run: kit add posthog/analytics",
    "  (Self-hosted: also set NEXT_PUBLIC_POSTHOG_HOST=https://your-posthog-host.com)",
    "  (EU cloud: set NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com)",
  ],
});
