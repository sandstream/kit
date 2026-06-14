import { apiKeyAdapter } from "./api-key-adapter.js";

/**
 * Tinybird — real-time analytics on ClickHouse.
 * API-based; reuses TINYBIRD_TOKEN and carries an optional region API URL.
 */
export const tinybirdAnalyticsAdapter = apiKeyAdapter({
  name: "tinybird/analytics",
  description: "Tinybird real-time analytics on ClickHouse",
  required: ["TINYBIRD_TOKEN"],
  optional: [{ env: "TINYBIRD_API_URL", default: "https://api.tinybird.co" }],
  steps: [
    "Set TINYBIRD_TOKEN before running kit add tinybird/analytics:",
    "  1. Go to https://app.tinybird.co and create a workspace",
    "  2. Navigate to Tokens → copy the admin token",
    "  3. Export it: export TINYBIRD_TOKEN=p.eyJ...",
    "  4. Re-run: kit add tinybird/analytics",
    "  (EU region: also set TINYBIRD_API_URL=https://api.eu.tinybird.co)",
  ],
});
