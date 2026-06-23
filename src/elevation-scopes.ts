/**
 * Per-operation elevation-scope mapping.
 *
 * `requireElevation("rotate")` is too coarse — it treats every rotate-mode
 * the same. Some modes are reversible (scoped-key-mint with rollback),
 * others are hard cutovers (jwt-secret-roll). This module maps each
 * fine-grained operation to its canonical elevation-scope so the
 * elevation-gate matches the destructive nature of the actual call.
 *
 * Mapping principles:
 *   - Reversible ops → standard 15-min TTL scope (call `requireElevation`).
 *   - Irreversible ops → one-shot scope (call `consumeElevation`); marker
 *     is atomically deleted on use so the same elevation can't fire a
 *     second destructive op silently.
 *
 * Callers ask `scopeFor(operation, mode)` to get the canonical scope name
 * + whether it's one-shot. They never hard-code scope strings.
 */

export interface ElevationScopeMapping {
  /** Canonical scope name passed to requireElevation / consumeElevation. */
  scope: string;
  /** One-shot scopes consume their elevation marker on first use. */
  oneShot: boolean;
  /** Human-readable description for audit-log + CLI help text. */
  description: string;
}

/**
 * `<operation>:<mode>` → mapping. Operations like "rotate" have multiple
 * modes; bare keys (no `:<mode>`) act as fallbacks.
 */
const SCOPE_MAP: Record<string, ElevationScopeMapping> = {
  // Rotation modes
  "rotate:jwt-secret-roll": {
    // Distinct scope (not "rotate"): the irreversible HARD CUTOVER must NOT be
    // authorizable by an elevation minted for the reversible scoped-key-mint.
    // Sharing "rotate" let a benign `--scope rotate` marker fire the cutover
    // within its TTL.
    scope: "rotate-jwt-cutover",
    oneShot: true,
    description: "Supabase JWT-secret reset — invalidates anon + service_role + all sessions",
  },
  "rotate:scoped-key-mint": {
    scope: "rotate",
    oneShot: false,
    description: "Supabase scoped-key mint — additive, old key remains until revoke-old",
  },
  rotate: {
    scope: "rotate",
    oneShot: false,
    description: "Generic credential rotation",
  },

  // Migration
  "migrate:plaintext-to-vault": {
    scope: "migrate",
    oneShot: false,
    description: "Plaintext .env* → vault migration",
  },
  "migrate:vault-to-vault": {
    scope: "vault-migrate",
    oneShot: true,
    description: "Cross-vault migration (e.g. 1Password → Infisical)",
  },
  migrate: {
    scope: "migrate",
    oneShot: false,
    description: "Generic secret migration",
  },

  // Propagation
  propagate: {
    scope: "propagate",
    oneShot: false,
    description: "Sync secrets from kit to deploy platform (Vercel / Fly / etc.)",
  },

  // History rewrite — irreversible
  "purge-history": {
    scope: "purge-history",
    oneShot: true,
    description: "git filter-repo / BFG — rewrites history, requires force-push",
  },

  // OneCLI register
  "onecli-register": {
    scope: "onecli-register",
    oneShot: true,
    description: "Register fake-key in OneCLI gateway",
  },

  // Revoke
  "revoke-old": {
    scope: "revoke-old",
    oneShot: false,
    description: "Revoke superseded credential after rotation",
  },
};

export function scopeFor(operation: string, mode?: string): ElevationScopeMapping {
  if (mode) {
    const composite = `${operation}:${mode}`;
    if (SCOPE_MAP[composite]) return SCOPE_MAP[composite];
  }
  if (SCOPE_MAP[operation]) return SCOPE_MAP[operation];
  return {
    scope: operation,
    oneShot: false,
    description: `Unmapped operation "${operation}" — using bare scope`,
  };
}

/**
 * Returns true when the (operation, mode) pair requires one-shot elevation.
 * Convenience helper for callers that need to pick between requireElevation
 * and consumeElevation at runtime.
 */
export function isOneShot(operation: string, mode?: string): boolean {
  return scopeFor(operation, mode).oneShot;
}

/**
 * Lists every mapping — used by `kit auth elevate --list-scopes` to
 * surface what scopes are available + their one-shot status.
 */
export function listScopes(): Array<{ key: string } & ElevationScopeMapping> {
  return Object.entries(SCOPE_MAP).map(([key, m]) => ({ key, ...m }));
}
