/**
 * Orchestration for `kit secrets rotate <KEY> --via supabase-mgmt-api`.
 *
 * Two modes:
 *   - `jwt-secret-roll`     hard cutover, invalidates every existing token
 *   - `scoped-key-mint`     mints a new secret key, leaves old ones live
 *                           (recommended unless the leak forces immediate
 *                           revocation of all sessions)
 */

import {
  makeClient,
  rollJwtSecret,
  mintScopedKey,
  listApiKeys,
  detectKeyMode,
  type MgmtClient,
  type RotateMode,
  type RotateResult,
  type ProjectKeyMode,
} from "./mgmt-api.js";

export interface SupabaseRotationOptions {
  projectRef: string;
  mode: RotateMode;
  /** Override the auto-generated key name for scoped-key-mint mode. */
  keyName?: string;
  /** PAT — falls back to SUPABASE_ACCESS_TOKEN env var. */
  accessToken?: string;
  baseUrl?: string;
}

export interface SupabaseRotationOutcome {
  ok: boolean;
  result?: RotateResult;
  error?: string;
}

/**
 * High-level rotate-and-return-new-value flow. The caller (kit core)
 * then pipes the returned value through the existing vault-write +
 * propagation pipeline — this module deliberately doesn't write to disk
 * or call any 1Password / vault API.
 */
export async function rotateSupabaseKey(
  opts: SupabaseRotationOptions,
): Promise<SupabaseRotationOutcome> {
  let client: MgmtClient;
  try {
    client = makeClient({ accessToken: opts.accessToken, baseUrl: opts.baseUrl });
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    let result: RotateResult;
    if (opts.mode === "jwt-secret-roll") {
      result = await rollJwtSecret(client, opts.projectRef);
    } else {
      result = await mintScopedKey(client, opts.projectRef, { name: opts.keyName });
    }
    return { ok: true, result };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Lighter-weight probe: confirms the PAT works and surfaces the current
 * key set without rotating. Used by `kit` to dry-run the rotation
 * before committing.
 */
export async function previewSupabaseRotation(opts: {
  projectRef: string;
  accessToken?: string;
  baseUrl?: string;
}): Promise<{
  ok: boolean;
  existingKeyCount?: number;
  keyMode?: ProjectKeyMode;
  recommendedMode?: RotateMode;
  warning?: string;
  error?: string;
}> {
  try {
    const client = makeClient({
      accessToken: opts.accessToken,
      baseUrl: opts.baseUrl,
    });
    const keyMode = await detectKeyMode(client, opts.projectRef);

    // Pick the rotation mode that's compatible with what the project
    // actually accepts. Mint a scoped key only when the project supports
    // them; otherwise the only safe path is a JWT-secret roll.
    let recommendedMode: RotateMode;
    let warning: string | undefined;
    if (keyMode.supportsScopedKeys) {
      recommendedMode = "scoped-key-mint";
    } else if (keyMode.supportsLegacyJwt) {
      recommendedMode = "jwt-secret-roll";
      warning =
        "Project still uses legacy JWT keys (anon/service_role). " +
        "scoped-key-mint would mint a key the project's PostgREST won't accept as service_role — " +
        "must use jwt-secret-roll instead (invalidates all existing tokens atomically).";
    } else {
      recommendedMode = "scoped-key-mint";
      warning = "Could not detect key mode from API response — using scoped-key-mint default.";
    }

    return {
      ok: true,
      existingKeyCount: keyMode.keyCount,
      keyMode,
      recommendedMode,
      warning,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
