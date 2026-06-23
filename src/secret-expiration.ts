import type { GovernanceConfig, SecretsConfig, SecretKeyConfig } from "./config.js";
import { mergeGovernanceConfig } from "./governance.js";
import { exec } from "./utils/exec.js";

export interface SecretExpiration {
  key: string;
  expiry_date?: string;
  days_until_expiry?: number;
  expired: boolean;
  warning: boolean;
}

/**
 * Check if secrets are expiring or expired.
 * Queries expiration metadata from secret stores and config-based hints.
 */
export async function checkSecretExpiration(
  config: GovernanceConfig | undefined,
  secretKeys: string[],
  secretsConfig?: SecretsConfig,
): Promise<SecretExpiration[]> {
  const fullConfig = mergeGovernanceConfig(config);

  if (!fullConfig.secrets?.check_expiration) {
    return [];
  }

  const expirations: SecretExpiration[] = [];
  const warnDays = fullConfig.secrets.warn_days_before_expiry || 30;

  for (const key of secretKeys) {
    const keyConfig = secretsConfig?.keys?.[key];
    const expiration = await getSecretExpiration(key, keyConfig, secretsConfig);

    if (expiration) {
      const daysUntilExpiry = calculateDaysUntilExpiry(expiration);
      const expired = daysUntilExpiry !== null && daysUntilExpiry < 0;
      const warning =
        daysUntilExpiry !== null && daysUntilExpiry >= 0 && daysUntilExpiry <= warnDays;

      expirations.push({
        key,
        expiry_date: expiration,
        days_until_expiry: daysUntilExpiry ?? undefined,
        expired,
        warning,
      });
    }
  }

  return expirations;
}

/**
 * Dispatch to the appropriate store adapter to fetch expiration metadata.
 * Falls back to config-based env var hints for stores that don't support
 * native expiration (Infisical, Doppler, Bitwarden, env).
 */
async function getSecretExpiration(
  key: string,
  keyConfig?: SecretKeyConfig,
  secretsConfig?: SecretsConfig,
): Promise<string | null> {
  const source = keyConfig?.source ?? secretsConfig?.store ?? "env";

  switch (source) {
    case "1password": {
      const ref = keyConfig?.ref;
      if (ref) {
        const expires = await get1PasswordExpiration(ref);
        if (expires !== null) return expires;
      }
      // Fall back to env hint if op returns no expiry data
      return getEnvExpirationHint(key);
    }

    case "infisical":
      // Infisical does not expose native per-secret expiration via CLI.
      // Rely on the operator setting the env var hint.
      return getEnvExpirationHint(key);

    case "doppler":
      // Doppler secrets do not have per-secret expiration dates.
      // Rely on the operator setting the env var hint.
      return getEnvExpirationHint(key);

    case "bitwarden":
      // Bitwarden item expiration is not exposed via CLI secret reads.
      // Rely on the operator setting the env var hint.
      return getEnvExpirationHint(key);

    default:
      // For env, config, eas, and any unknown source use env hint only.
      return getEnvExpirationHint(key);
  }
}

/**
 * Read a config-based expiration hint from environment variable.
 *
 * Convention: set `<KEY>_EXPIRES_AT=<ISO-date>` to declare expiration
 * for any secret, regardless of which store it lives in. This is the
 * universal fallback for stores that do not expose expiration metadata.
 *
 * Example: API_KEY_EXPIRES_AT=2026-12-31T00:00:00Z
 */
export function getEnvExpirationHint(key: string): string | null {
  const envVarName = `${key.toUpperCase()}_EXPIRES_AT`;
  const value = process.env[envVarName];
  if (!value) return null;

  const date = new Date(value);
  if (isNaN(date.getTime())) {
    console.warn(`[kit] Invalid expiration date for ${key}: ${value}`);
    return null;
  }
  return date.toISOString();
}

/**
 * Fetch expiration date from a 1Password item.
 *
 * Parses refs in the format `op://vault/item/field` or `vault/item`.
 * Calls `op item get <item> --vault <vault> --format json` and returns
 * the `expires` field if present.
 *
 * Returns null if the item has no expiry, if op is unavailable, or if
 * the ref cannot be parsed.
 */
export async function get1PasswordExpiration(ref: string): Promise<string | null> {
  try {
    // Parse "op://vault/item/field" or "vault/item" or "op://vault/item"
    const cleaned = ref.startsWith("op://") ? ref.slice(5) : ref;
    const parts = cleaned.split("/");
    if (parts.length < 2) return null;

    const [vault, item] = parts;
    if (!vault || !item) return null;

    const { stdout } = await exec(
      "op",
      ["item", "get", item, "--vault", vault, "--format", "json"],
      { timeout: 10_000 },
    );

    const data = JSON.parse(stdout) as { expires?: string };
    return data.expires ?? null;
  } catch {
    // op CLI not available, not signed in, or item has no expiry field
    return null;
  }
}

/**
 * Calculate days until expiration (negative = already expired)
 */
function calculateDaysUntilExpiry(expiryDate: string): number | null {
  try {
    const expiry = new Date(expiryDate);
    const now = new Date();
    const diffMs = expiry.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    return diffDays;
  } catch {
    return null;
  }
}

/**
 * Format secret expiration warnings for display
 */
export function formatSecretExpirationWarnings(expirations: SecretExpiration[]): string {
  const expired = expirations.filter((e) => e.expired);
  const warning = expirations.filter((e) => e.warning);

  if (expired.length === 0 && warning.length === 0) {
    return "All secrets are current (no expiration warnings).";
  }

  const lines: string[] = [];

  if (expired.length > 0) {
    lines.push("⚠️  EXPIRED SECRETS:");
    for (const e of expired) {
      lines.push(`  ✗ ${e.key} expired ${Math.abs(e.days_until_expiry || 0)} days ago`);
    }
    lines.push("");
  }

  if (warning.length > 0) {
    lines.push("⚠️  EXPIRING SOON:");
    for (const w of warning) {
      lines.push(`  ! ${w.key} expires in ${w.days_until_expiry} days`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Check if any secrets are expired (blocking check)
 */
export function hasExpiredSecrets(expirations: SecretExpiration[]): boolean {
  return expirations.some((e) => e.expired);
}

/**
 * Check if any secrets have warnings
 */
export function hasSecretWarnings(expirations: SecretExpiration[]): boolean {
  return expirations.some((e) => e.warning);
}
