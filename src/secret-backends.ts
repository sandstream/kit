import { check1PasswordStatus } from "./onepassword.js";
import { exec } from "./utils/exec.js";
import type { SecretKeyConfig, InfisicalConfig } from "./config.js";
import type { SecretResolveResult } from "./secrets.js";

/**
 * Single source of truth for every secret backend kit speaks to.
 *
 * Each backend declares how to `resolve` (read) a value and, optionally, how
 * to `write` one. A backend with no `write` is read-only — migration to it is
 * unsupported, surfaced uniformly by {@link writeViaBackend}. Keeping read and
 * write side-by-side in one object is the whole point: the previous design had
 * two independent `switch (source)` statements (one in secrets.ts, one in
 * secrets-migrate.ts), so adding a backend to one and forgetting the other
 * failed silently. Here the omission is visible in a single place — and the
 * read/write capability matrix is asserted in secret-backends.test.ts.
 */

export interface WriteOpts {
  vault?: string;
  project?: string;
  region?: string;
  vaultPath?: string;
}

export interface WriteResult {
  ok: boolean;
  ref?: string;
  detail: string;
}

export interface SecretBackend {
  /** Read a secret value for `name` using its `config`. Never throws — failures
   *  come back as `{ resolved: false, detail }`. */
  resolve(
    name: string,
    config: SecretKeyConfig,
    infisicalConfig?: InfisicalConfig,
  ): Promise<SecretResolveResult>;
  /** Write a secret. Absent ⇒ the backend is read-only (migration unsupported).
   *  May throw; callers wrap it so the error is redacted before surfacing.
   *
   *  Value handling: where the CLI supports it, the value is fed via stdin so it
   *  never lands in argv / the process table (vault `kv put -`, aws/gcp
   *  `file:///dev/stdin` / `--data-file=-`). The 1Password, Infisical, Doppler and
   *  Azure CLIs only accept the value as a `key=value` / `--value` argv token for
   *  these operations, so it is briefly visible in `ps` there — an inherent CLI
   *  limitation. The error path is covered regardless: writeSecretToBackend redacts
   *  the held plaintext by exact substring before any failure message is surfaced. */
  write?(key: string, value: string, opts: WriteOpts): Promise<WriteResult>;
}

// ─── Infisical bulk-fetch cache (avoids repeated CLI calls per generate) ──────

let infisicalCache: Map<string, string> | null = null;

/** Reset the Infisical cache. Called once per `generateSecrets` run. */
export function resetInfisicalCache(): void {
  infisicalCache = null;
}

async function fetchInfisicalSecrets(
  infisicalConfig?: InfisicalConfig,
): Promise<Map<string, string>> {
  if (infisicalCache) return infisicalCache;

  const env = infisicalConfig?.environment ?? "dev";

  try {
    const exportArgs = ["export", "--format=json", "--env", env];
    if (infisicalConfig?.project_id) {
      exportArgs.push("--projectId", infisicalConfig.project_id);
    }
    if (infisicalConfig?.path) {
      exportArgs.push("--path", infisicalConfig.path);
    }

    const { stdout } = await exec("infisical", exportArgs, {
      timeout: 15_000,
      env: { ...process.env },
    });
    const secrets = JSON.parse(stdout);
    const cache = new Map<string, string>();
    if (Array.isArray(secrets)) {
      for (const s of secrets as { key: string; value: string }[]) {
        cache.set(s.key, s.value);
      }
    } else if (typeof secrets === "object" && secrets !== null) {
      for (const [k, v] of Object.entries(secrets)) {
        if (typeof v === "string") cache.set(k, v);
      }
    }
    infisicalCache = cache;
    return cache;
  } catch {
    infisicalCache = new Map();
    return infisicalCache;
  }
}

// ─── Backend registry ─────────────────────────────────────────────────────────

export const BACKENDS: Record<string, SecretBackend> = {
  env: {
    async resolve(name) {
      const val = process.env[name] ?? null;
      return {
        name,
        resolved: val !== null,
        value: val,
        detail: val ? "From environment" : "Not set in environment",
      };
    },
    // read-only: env vars are materialized, never written by kit
  },

  config: {
    async resolve(name, config) {
      const val = config.value ?? null;
      return { name, resolved: val !== null, value: val, detail: "From config" };
    },
    // read-only: inline config values aren't a writable store
  },

  "1password": {
    async resolve(name, config) {
      if (!config.ref) {
        return { name, resolved: false, value: null, detail: "No 1Password ref configured" };
      }
      const opStatus = await check1PasswordStatus();
      if (!opStatus.installed) {
        return {
          name,
          resolved: false,
          value: null,
          detail: `1Password CLI not installed: ${opStatus.error}`,
        };
      }
      if (!opStatus.authenticated) {
        return {
          name,
          resolved: false,
          value: null,
          detail: `Not signed into 1Password: ${opStatus.error}`,
        };
      }
      try {
        const { stdout } = await exec("op", ["read", config.ref, "--no-newline"], {
          timeout: 10_000,
        });
        return { name, resolved: !!stdout, value: stdout || null, detail: "From 1Password" };
      } catch {
        return {
          name,
          resolved: false,
          value: null,
          detail: `1Password reference not found: ${config.ref}`,
        };
      }
    },
    async write(key, value, opts) {
      // Pre-flight: skip the op command if no account is configured. Otherwise
      // op interactively prompts ("Do you want to add an account manually now?
      // [Y/n]") and blocks the whole rotate flow.
      const opStatus = await check1PasswordStatus();
      if (!opStatus.installed) {
        return {
          ok: false,
          detail: "1Password CLI not installed — install op or pick a different store",
        };
      }
      if (!opStatus.authenticated) {
        return {
          ok: false,
          detail:
            "1Password CLI present but no account configured. Run 'op account add' first (or set OP_SERVICE_ACCOUNT_TOKEN). Skipping vault-write; value will be printed for manual capture.",
        };
      }
      const vault = opts.vault || "Dev";
      const project = opts.project || "Project";
      // Try edit first (existing item), fall back to create. Both paths run with
      // PIPE stdin so the parent doesn't inherit op's interactive prompts even if
      // auth lapses mid-flight.
      try {
        await exec("op", ["item", "edit", project, `${key}=${value}`, "--vault", vault], {
          timeout: 15_000,
        });
      } catch {
        await exec("op", [
          "item",
          "create",
          `--category=Login`,
          `--title=${project}`,
          `--vault=${vault}`,
          `${key}=${value}`,
        ], { timeout: 15_000 });
      }
      return { ok: true, ref: `op://${vault}/${project}/${key}`, detail: "wrote to 1Password" };
    },
  },

  eas: {
    async resolve(name, config) {
      try {
        const { stdout } = await exec("eas", ["secret:list", "--json"], { timeout: 10_000 });
        const secrets = JSON.parse(stdout);
        const found =
          Array.isArray(secrets) &&
          secrets.some((s: { name: string }) => s.name === (config.name || name));
        return {
          name,
          resolved: found,
          value: found ? "(managed by EAS)" : null,
          detail: found ? "Found in EAS" : "Not found in EAS",
          managed: true, // EAS holds the value; the string above is a display placeholder
        };
      } catch {
        return { name, resolved: false, value: null, detail: "EAS CLI not available" };
      }
    },
    // read-only: EAS secrets are managed by `eas secret:*`, not migrated into
  },

  infisical: {
    async resolve(name, config, infisicalConfig) {
      try {
        const cache = await fetchInfisicalSecrets(infisicalConfig);
        const key = config.name || name;
        const val = cache.get(key) ?? null;
        return {
          name,
          resolved: val !== null,
          value: val,
          detail: val !== null ? "From Infisical" : "Not found in Infisical",
        };
      } catch {
        return { name, resolved: false, value: null, detail: "Infisical CLI not available" };
      }
    },
    async write(key, value) {
      await exec("infisical", ["secrets", "set", `${key}=${value}`], { timeout: 15_000 });
      return { ok: true, detail: "wrote to Infisical" };
    },
  },

  bitwarden: {
    async resolve(name, config) {
      if (!config.name && !config.ref) {
        return { name, resolved: false, value: null, detail: "No Bitwarden field name configured" };
      }
      try {
        const fieldName = config.name || config.ref || name;
        const { stdout } = await exec("bw", ["get", fieldName], { timeout: 10_000 });
        return { name, resolved: !!stdout, value: stdout || null, detail: "From Bitwarden" };
      } catch {
        return {
          name,
          resolved: false,
          value: null,
          detail: "Bitwarden CLI not available or secret not found",
        };
      }
    },
    // read-only: `bw` write semantics (folders/collections) aren't modeled yet
  },

  doppler: {
    async resolve(name, config) {
      if (!config.name) {
        return { name, resolved: false, value: null, detail: "No Doppler secret name configured" };
      }
      try {
        const { stdout } = await exec("doppler", ["secrets", "get", config.name, "--plain"], {
          timeout: 10_000,
        });
        return { name, resolved: !!stdout, value: stdout || null, detail: "From Doppler" };
      } catch {
        return {
          name,
          resolved: false,
          value: null,
          detail: "Doppler CLI not available or secret not found",
        };
      }
    },
    async write(key, value) {
      await exec("doppler", ["secrets", "set", `${key}=${value}`], { timeout: 15_000 });
      return { ok: true, detail: "wrote to Doppler" };
    },
  },

  dotenvx: {
    async resolve(name, config) {
      // `dotenvx get <KEY>` prints the decrypted value to stdout, using
      // DOTENV_PRIVATE_KEY (from .env.keys or the environment). `config.name`
      // overrides the lookup key; the file defaults to ./.env.
      const key = config.name || name;
      try {
        const { stdout } = await exec("dotenvx", ["get", key], { timeout: 10_000 });
        const val = stdout.trim();
        return {
          name,
          resolved: !!val,
          value: val || null,
          detail: val ? "From dotenvx" : "Not found in dotenvx .env",
        };
      } catch {
        return {
          name,
          resolved: false,
          value: null,
          detail: "dotenvx CLI not available or key not found",
        };
      }
    },
    async write(key, value) {
      // `dotenvx set <KEY> <value>` encrypts the value into .env (ECIES). The
      // value is an argv token — see the SecretBackend.write note on exposure.
      await exec("dotenvx", ["set", key, value], { timeout: 15_000 });
      return { ok: true, detail: "encrypted into .env via dotenvx" };
    },
  },

  vault: {
    async resolve(name, config) {
      const path = config.vault_path || config.ref;
      const field = config.vault_field || config.name;
      if (!path || !field) {
        return {
          name,
          resolved: false,
          value: null,
          detail: "vault: vault_path and vault_field (or ref/name) required",
        };
      }
      try {
        const { stdout } = await exec("vault", ["kv", "get", "-field", field, path], {
          timeout: 10_000,
        });
        const val = stdout.trim();
        return {
          name,
          resolved: !!val,
          value: val || null,
          detail: val ? "From Vault" : "Empty in Vault",
        };
      } catch {
        return {
          name,
          resolved: false,
          value: null,
          detail: "Vault CLI not available or not authenticated",
        };
      }
    },
    async write(key, value, opts) {
      const path = opts.vaultPath || "secret/data/kit";
      // `vault kv put - <path>` reads KEY=value pairs from stdin; keeps value out
      // of argv (and out of any error message).
      await exec("vault", ["kv", "put", "-", path], {
        timeout: 15_000,
        input: `${key}=${value}\n`,
      } as Parameters<typeof exec>[2]);
      return { ok: true, detail: `wrote to Vault path ${path}` };
    },
  },

  "aws-sm": {
    async resolve(name, config) {
      const secretId = config.name || config.ref || name;
      const args = [
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        secretId,
        "--query",
        "SecretString",
        "--output",
        "text",
      ];
      if (config.aws_region) args.push("--region", config.aws_region);
      try {
        const { stdout } = await exec("aws", args, { timeout: 15_000 });
        const val = stdout.trim();
        if (!val || val === "None") {
          return { name, resolved: false, value: null, detail: "AWS: secret empty or not found" };
        }
        return { name, resolved: true, value: val, detail: "From AWS Secrets Manager" };
      } catch {
        return {
          name,
          resolved: false,
          value: null,
          detail: "AWS CLI not available or not authenticated",
        };
      }
    },
    async write(key, value, opts) {
      // `--secret-string file:///dev/stdin` reads the value from stdin instead of
      // argv, so the credential never lands in ps / error messages.
      const args = [
        "secretsmanager",
        "create-secret",
        "--name",
        key,
        "--secret-string",
        "file:///dev/stdin",
      ];
      if (opts.region) args.push("--region", opts.region);
      try {
        await exec("aws", args, { timeout: 15_000, input: value } as Parameters<typeof exec>[2]);
      } catch {
        const update = [
          "secretsmanager",
          "put-secret-value",
          "--secret-id",
          key,
          "--secret-string",
          "file:///dev/stdin",
        ];
        if (opts.region) update.push("--region", opts.region);
        await exec("aws", update, { timeout: 15_000, input: value } as Parameters<typeof exec>[2]);
      }
      return { ok: true, detail: "wrote to AWS Secrets Manager" };
    },
  },

  "gcp-sm": {
    async resolve(name, config) {
      const secretName = config.name || config.ref || name;
      const version = config.gcp_version || "latest";
      const args = ["secrets", "versions", "access", version, "--secret", secretName];
      const project =
        config.gcp_project || process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
      if (project) args.push("--project", project);
      try {
        const { stdout } = await exec("gcloud", args, { timeout: 15_000 });
        const val = stdout.trim();
        return {
          name,
          resolved: !!val,
          value: val || null,
          detail: val ? "From GCP Secret Manager" : "Empty in GCP Secret Manager",
        };
      } catch {
        return {
          name,
          resolved: false,
          value: null,
          detail: "gcloud CLI not available or not authenticated",
        };
      }
    },
    async write(key, value, opts) {
      // gcloud requires the secret to exist first; create then add version.
      const createArgs = [
        "secrets",
        "create",
        key,
        "--data-file=-",
        "--replication-policy=automatic",
      ];
      if (opts.project) createArgs.push("--project", opts.project);
      try {
        await exec("gcloud", createArgs, {
          timeout: 15_000,
          input: value,
        } as Parameters<typeof exec>[2]);
      } catch {
        const addArgs = ["secrets", "versions", "add", key, "--data-file=-"];
        if (opts.project) addArgs.push("--project", opts.project);
        await exec("gcloud", addArgs, {
          timeout: 15_000,
          input: value,
        } as Parameters<typeof exec>[2]);
      }
      return { ok: true, detail: "wrote to GCP Secret Manager" };
    },
  },

  "azure-kv": {
    async resolve(name, config) {
      const secretName = config.name || config.ref || name;
      const vault = config.azure_vault || process.env.AZURE_KEYVAULT_NAME;
      if (!vault) {
        return {
          name,
          resolved: false,
          value: null,
          detail: "Azure: azure_vault or AZURE_KEYVAULT_NAME required",
        };
      }
      const args = [
        "keyvault",
        "secret",
        "show",
        "--vault-name",
        vault,
        "--name",
        secretName,
        "--query",
        "value",
        "-o",
        "tsv",
      ];
      try {
        const { stdout } = await exec("az", args, { timeout: 15_000 });
        const val = stdout.trim();
        return {
          name,
          resolved: !!val,
          value: val || null,
          detail: val ? "From Azure Key Vault" : "Empty in Azure Key Vault",
        };
      } catch {
        return {
          name,
          resolved: false,
          value: null,
          detail: "Azure CLI not available or not authenticated",
        };
      }
    },
    async write(key, value, opts) {
      if (!opts.vault) {
        return { ok: false, detail: "Azure: --vault required (azure_vault or AZURE_KEYVAULT_NAME)" };
      }
      await exec("az", [
        "keyvault",
        "secret",
        "set",
        "--vault-name",
        opts.vault,
        "--name",
        key,
        "--value",
        value,
      ], { timeout: 15_000 });
      return { ok: true, detail: `wrote to Azure Key Vault ${opts.vault}` };
    },
  },
};

/** Resolve (read) a secret via the registry. Mirrors the old `resolveSecret`
 *  switch — unknown sources return a uniform `Unknown source` result. */
export async function resolveViaBackend(
  name: string,
  config: SecretKeyConfig,
  infisicalConfig?: InfisicalConfig,
): Promise<SecretResolveResult> {
  const backend = BACKENDS[config.source];
  if (!backend) {
    return { name, resolved: false, value: null, detail: `Unknown source: ${config.source}` };
  }
  return backend.resolve(name, config, infisicalConfig);
}

/** Write a secret via the registry. Backends without a `write` are read-only;
 *  the "not yet supported" message matches the old switch default verbatim. */
export async function writeViaBackend(
  store: string,
  key: string,
  value: string,
  opts: WriteOpts,
): Promise<WriteResult> {
  const backend = BACKENDS[store];
  if (!backend?.write) {
    return { ok: false, detail: `migration to '${store}' not yet supported — write manually` };
  }
  return backend.write(key, value, opts);
}
