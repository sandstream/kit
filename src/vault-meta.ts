import type { SecretsStore } from "./toml-generator.js";

/**
 * Single source of truth for every secret backend kit can wire up.
 *
 * The point of this file is to close a silent dead-end: choosing a vault at
 * `kit init` used to record `store = "<vault>"` and nothing else — the CLI was
 * never installed, no login was guided, and `kit secrets` just failed key by
 * key with "CLI not available". Three consumers now read from here so the choice
 * is actually provisioned end-to-end:
 *
 *  - `toml-generator` adds {@link VaultMeta.miseTool} to `[tools]` so
 *    `kit setup` installs the vault CLI like any other tool.
 *  - `cli` (secrets / setup) uses {@link VaultMeta.loginCmd} / {@link initCmd}
 *    to print a LOUD, actionable "chosen but not authenticated yet" hint instead
 *    of a wall of silent per-key failures.
 *  - the secret backends resolve that same CLI mise-first (see `execCli`), so
 *    the binary kit just installed is actually found.
 *
 * `miseTool` is set only for vaults whose CLI mise can install. Cloud secret
 * managers (aws/gcp/azure) ship their CLI through the cloud environment / IAM,
 * not mise — kit guides their login but does not try to provision the binary.
 */
export interface VaultMeta {
  label: string;
  /** mise registry key kit adds to `[tools]` so `kit setup` installs the CLI.
   *  Absent ⇒ kit does not provision this backend's CLI (cloud-managed). */
  miseTool?: string;
  /** How the user authenticates. This stays the user's own account action —
   *  kit guides it, never runs it. */
  loginCmd?: string;
  /** Optional repo-binding step run after login (e.g. `infisical init` writes
   *  `.infisical.json`, binding this checkout to a project/environment). */
  initCmd?: string;
}

export const VAULT_META: Record<Exclude<SecretsStore, "env">, VaultMeta> = {
  "1password": { label: "1Password", miseTool: "1password", loginCmd: "op signin" },
  infisical: {
    label: "Infisical",
    miseTool: "infisical",
    loginCmd: "infisical login",
    initCmd: "infisical init",
  },
  doppler: { label: "Doppler", miseTool: "doppler", loginCmd: "doppler login", initCmd: "doppler setup" },
  bitwarden: { label: "Bitwarden", miseTool: "bitwarden", loginCmd: "bw login && bw unlock" },
  vault: { label: "HashiCorp Vault", miseTool: "vault", loginCmd: "vault login" },
  "aws-sm": { label: "AWS Secrets Manager", loginCmd: "aws configure  (or assume an IAM role)" },
  "gcp-sm": { label: "GCP Secret Manager", loginCmd: "gcloud auth login" },
  "azure-kv": { label: "Azure Key Vault", loginCmd: "az login" },
};

/** Vault metadata for a configured `store`, or null for `env` / unknown. */
export function vaultMeta(store: string | undefined): VaultMeta | null {
  if (!store || store === "env") return null;
  return (VAULT_META as Record<string, VaultMeta>)[store] ?? null;
}

/**
 * Detect a secret backend a brownfield repo is already bound to, from its
 * marker files, so `kit init` can pre-select the right store instead of
 * defaulting to 1Password (and hardcoding the wrong one in `--yes` runs).
 * Returns null when nothing recognizable is present.
 */
export async function detectSecretStore(
  fileExists: (relPath: string) => Promise<boolean>,
): Promise<SecretsStore | null> {
  if (await fileExists(".infisical.json")) return "infisical";
  if ((await fileExists("doppler.yaml")) || (await fileExists(".doppler.yaml"))) return "doppler";
  return null;
}
