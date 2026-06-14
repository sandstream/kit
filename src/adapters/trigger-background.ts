import { apiKeyAdapter } from "./api-key-adapter.js";

/**
 * Trigger.dev — background jobs and event-driven workflows.
 * API-based; reuses TRIGGER_SECRET_KEY (validated by its `tr_` prefix) and
 * carries an optional API URL for self-hosted instances.
 */
export const triggerBackgroundAdapter = apiKeyAdapter({
  name: "trigger/background",
  description: "Trigger.dev background jobs and event-driven workflows",
  required: [{ env: "TRIGGER_SECRET_KEY", prefix: "tr_" }],
  optional: [{ env: "TRIGGER_API_URL", default: "https://api.trigger.dev" }],
  steps: [
    "Set TRIGGER_SECRET_KEY before running kit add trigger/background:",
    "  1. Go to https://cloud.trigger.dev and create a project",
    "  2. Navigate to API keys → copy the secret key (starts with tr_)",
    "  3. Export it: export TRIGGER_SECRET_KEY=tr_...",
    "  4. Re-run: kit add trigger/background",
  ],
});
