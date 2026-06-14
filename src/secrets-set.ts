/**
 * `kit secrets set-value <KEY> <VALUE> --env <env>` — write a single
 * key/value to the configured vault backend without going through the
 * full migrate flow. Replaces the manual `nano .env.production`
 * workflow.
 *
 * Honors read-only mode (delegates to writeSecretToBackend which has the
 * gate). Audit-log entry written by the underlying backend write.
 */

import type { SecretsConfig } from "./config.js";
import { writeSecretToBackend, isValidKeyName } from "./secrets-migrate.js";

export interface SetValueOptions {
  /** Override config.secrets.store with this backend. */
  store?: SecretsConfig["store"];
  /** Vault path / project / region overrides (per-backend). */
  vault?: string;
  project?: string;
  region?: string;
  vaultPath?: string;
}

export interface SetValueResult {
  ok: boolean;
  detail: string;
  ref?: string;
}

export async function setSecretValue(
  config: SecretsConfig | undefined,
  key: string,
  value: string,
  opts: SetValueOptions = {},
): Promise<SetValueResult> {
  if (!isValidKeyName(key)) {
    return { ok: false, detail: `invalid key name "${key}"` };
  }
  if (!value) {
    return { ok: false, detail: `empty value for "${key}"` };
  }
  const store = opts.store ?? config?.store;
  if (!store || store === "env") {
    return {
      ok: false,
      detail: "no vault backend configured (set [secrets].store first)",
    };
  }
  const backendOpts: SetValueOptions = {
    vault: opts.vault,
    project: opts.project,
    region: opts.region,
    vaultPath: opts.vaultPath,
  };
  return writeSecretToBackend(store, key, value, backendOpts);
}
