/**
 * `kit secrets pull --from <platform> --env <env>` — read env-vars
 * from a deploy-platform (Vercel / Fly / Cloudflare / GitHub Actions)
 * and write them into the local vault. Closes the "I forgot what
 * value is in the deploy platform" gap that drives real-world secret incidents.
 *
 * Read-only by nature of the source side (vendor REST is GET-only here).
 * Write side honors KIT_READ_ONLY=1 via writeSecretToBackend.
 */

import type { SecretsConfig } from "./config.js";

export type PullSource = "vercel" | "github" | "fly" | "cloudflare";

export interface PullOptions {
  source: PullSource;
  /** Deploy-platform-specific environment name (production / preview / dev). */
  env?: string;
  /** Project / repo / app identifier passed to the source plugin. */
  projectId?: string;
  /** Skip writing to vault; just list what would be pulled. */
  dryRun?: boolean;
  /** Target vault store. Defaults to config.secrets.store. */
  store?: SecretsConfig["store"];
}

export interface PullResult {
  source: PullSource;
  discovered: number;
  written: number;
  skipped: number;
  items: Array<{ key: string; status: "written" | "skipped" | "would-write"; detail: string }>;
}
