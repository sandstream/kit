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
import { writeSecretToBackend } from "./secrets-migrate.js";

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

/**
 * Fetches env-vars from the source platform. Each source uses its
 * existing kit-plugin's read-only API. Tokens come from the operator's
 * shell env per plugin convention (VERCEL_TOKEN, GITHUB_TOKEN, FLY_API_TOKEN,
 * CLOUDFLARE_API_TOKEN).
 */
async function fetchFromSource(
  source: PullSource,
  projectId: string,
  env?: string,
): Promise<Array<{ key: string; value: string; target?: string[] }>> {
  if (source === "vercel") {
    const { makeClient, listEnvVars } = await import("sandstream-kit-plugin-vercel" as string);
    const client = makeClient();
    const all = await listEnvVars(client, projectId);
    return all
      .filter((e: { value?: string; target?: string[] }) =>
        env ? (e.target ?? []).includes(env) : true,
      )
      .map((e: { key: string; value?: string; target?: string[] }) => ({
        key: e.key,
        value: e.value ?? "",
        target: e.target,
      }))
      .filter((e: { value: string }) => e.value.length > 0);
  }
  if (source === "github") {
    // GitHub Actions secrets are write-only via the API (you can list names
    // but never read values back). We surface name-only so the operator
    // knows what's defined upstream.
    const { makeClient, listRepoSecrets } = await import("sandstream-kit-plugin-github" as string);
    const [owner, repo] = projectId.split("/");
    if (!owner || !repo) {
      throw new Error("github source requires projectId in 'owner/repo' format");
    }
    const client = makeClient();
    const secrets = await listRepoSecrets(client, owner, repo);
    // Returning empty value — operator must hand-fill from another source.
    return secrets.map((s: { name: string }) => ({ key: s.name, value: "" }));
  }
  if (source === "fly") {
    // Fly secret VALUES are not retrievable via API (digest-only). Same
    // name-only path as GitHub.
    const { makeClient, listAppSecrets } = await import("sandstream-kit-plugin-fly" as string);
    const client = makeClient();
    const secrets = await listAppSecrets(client, projectId);
    return secrets.map((s: { name: string }) => ({ key: s.name, value: "" }));
  }
  if (source === "cloudflare") {
    const { makeClient, listWorkerSecrets } = await import(
      "sandstream-kit-plugin-cloudflare" as string
    );
    const client = makeClient();
    const secrets = await listWorkerSecrets(client, projectId);
    return secrets.map((s: { name: string }) => ({ key: s.name, value: "" }));
  }
  throw new Error(`Unknown pull source: ${source}`);
}

export async function pullSecrets(
  config: SecretsConfig | undefined,
  opts: PullOptions,
): Promise<PullResult> {
  if (!opts.projectId) {
    throw new Error("--project <id> required");
  }
  const source = opts.source;
  const env = opts.env;
  const found = await fetchFromSource(source, opts.projectId, env);
  const result: PullResult = {
    source,
    discovered: found.length,
    written: 0,
    skipped: 0,
    items: [],
  };
  const store = opts.store ?? config?.store;
  for (const item of found) {
    if (!item.value) {
      result.items.push({
        key: item.key,
        status: "skipped",
        detail:
          source === "github" || source === "fly" || source === "cloudflare"
            ? "vendor API does not expose secret value (name-only)"
            : "empty value at source",
      });
      result.skipped++;
      continue;
    }
    if (opts.dryRun) {
      result.items.push({
        key: item.key,
        status: "would-write",
        detail: `would write to ${store ?? "(no store configured)"}`,
      });
      continue;
    }
    if (!store || store === "env") {
      result.items.push({
        key: item.key,
        status: "skipped",
        detail: "no vault backend configured ([secrets].store)",
      });
      result.skipped++;
      continue;
    }
    const write = await writeSecretToBackend(store, item.key, item.value);
    result.items.push({
      key: item.key,
      status: write.ok ? "written" : "skipped",
      detail: write.detail,
    });
    if (write.ok) result.written++;
    else result.skipped++;
  }
  return result;
}
