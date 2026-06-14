import { apiKeyAdapter } from "./api-key-adapter.js";

/**
 * Sentry — error tracking and performance monitoring.
 * API-based; requires SENTRY_DSN (validated by its `https://` prefix) and
 * carries optional org/project/auth-token (pass-through, needed for CI
 * source-map uploads).
 */
export const sentryMonitoringAdapter = apiKeyAdapter({
  name: "sentry/monitoring",
  description: "Sentry error tracking and performance monitoring",
  required: [{ env: "SENTRY_DSN", prefix: "https://" }],
  optional: [
    { env: "SENTRY_ORG" },
    { env: "SENTRY_PROJECT" },
    { env: "SENTRY_AUTH_TOKEN" },
  ],
  steps: [
    "Set SENTRY_DSN before running kit add sentry/monitoring:",
    "  1. Go to https://sentry.io and create a project",
    "  2. Go to Settings → Projects → <project> → Client Keys (DSN)",
    "  3. Copy the DSN → SENTRY_DSN",
    "  4. Optionally set SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN",
    "     (needed for source map uploads in CI)",
    "  5. Re-run: kit add sentry/monitoring",
  ],
});
