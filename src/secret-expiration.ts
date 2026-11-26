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

/** One `fields[]` entry of `op item get --format json` (only what expiry needs). */
interface OnePasswordField {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  value?: unknown;
}

/** True when a field's label or id names an expiry: expires, expiry, expiration, valid until. */
function namesExpiry(field: OnePasswordField): boolean {
  return [field.label, field.id].some((name) => {
    if (typeof name !== "string") return false;
    const n = name.toLowerCase().replace(/[^a-z]/g, "");
    return n.includes("expir") || n.includes("validuntil");
  });
}

/**
 * Turn a 1Password DATE value into a timestamp (ms), or null.
 *
 * 1Password documents DATE input as `YYYY-MM-DD`; JSON output has been seen as
 * unix epoch seconds. Both are read. An empty value, epoch 0 (what an empty
 * date is coerced to) and anything unparseable mean "no date".
 */
function parse1PasswordDate(value: unknown): number | null {
  if (typeof value === "number") return parseEpochSeconds(value);
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return parseEpochSeconds(Number(v));
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  return Number.isNaN(ms) ? null : ms;
}

function parseEpochSeconds(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const ms = new Date(seconds * 1000).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read the expiry from `op item get --format json` output.
 *
 * 1Password items have no top-level expiry key; a date is a `fields[]` entry
 * with `type: "DATE"`. This takes the DATE fields whose label or id names an
 * expiry (see `namesExpiry`). When several match, the earliest wins, so the
 * gate warns about the soonest deadline rather than the latest.
 *
 * Returns an ISO string, or null when no such field holds a usable date.
 */
export function parse1PasswordExpiry(json: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const fields = (data as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return null;
  let earliest: number | null = null;
  for (const field of fields as OnePasswordField[]) {
    if (!field || field.type !== "DATE" || !namesExpiry(field)) continue;
    const ms = parse1PasswordDate(field.value);
    if (ms !== null && (earliest === null || ms < earliest)) earliest = ms;
  }
  return earliest === null ? null : new Date(earliest).toISOString();
}

/**
 * Fetch expiration date from a 1Password item.
 *
 * Parses refs in the format `op://vault/item/field` or `vault/item`, calls
 * `op item get <item> --vault <vault> --format json` and reads the expiry
 * from the item's DATE fields (`parse1PasswordExpiry`). This costs one
 * `op item get` per 1Password key on every governed command; nothing caches it.
 *
 * Returns null if the item has no expiry field, if op is unavailable, or if
 * the ref cannot be parsed. The caller then falls back to `<KEY>_EXPIRES_AT`.
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

    return parse1PasswordExpiry(stdout);
  } catch {
    // op CLI not available or not signed in
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
