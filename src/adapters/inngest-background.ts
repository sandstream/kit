import { apiKeyAdapter } from "./api-key-adapter.js";

/**
 * Inngest — event-driven background jobs and scheduled functions.
 * API-based; requires both the event key and signing key.
 */
export const inngestBackgroundAdapter = apiKeyAdapter({
  name: "inngest/background",
  description: "Inngest event-driven background jobs and scheduled functions",
  required: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
  steps: [
    "Set the following before running kit add inngest/background:",
    "  1. Go to https://app.inngest.com and create an app",
    "  2. Navigate to Settings → API keys",
    "  3. Copy the Event Key → INNGEST_EVENT_KEY",
    "  4. Copy the Signing Key → INNGEST_SIGNING_KEY",
    "  5. Re-run: kit add inngest/background",
  ],
});
