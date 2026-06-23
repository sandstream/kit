/**
 * Minimal Supabase Management API client.
 *
 * Auth: Personal Access Token (PAT) — generate at
 * https://supabase.com/dashboard/account/tokens. Provide via
 * `SUPABASE_ACCESS_TOKEN` env var or pass explicitly.
 *
 * The Management API surface evolves; this module sticks to the endpoints
 * needed for credential rotation:
 *   GET  /v1/projects                 → list projects (for sanity / project-ref discovery)
 *   GET  /v1/projects/{ref}/api-keys  → current anon / service_role / publishable keys
 *   POST /v1/projects/{ref}/api-keys  → mint a fresh secret (Sb scoped key family)
 *
 * Older projects still use the JWT-secret model where rolling the JWT secret
 * regenerates anon + service_role atomically. That endpoint:
 *   POST /v1/projects/{ref}/config/jwt-secret/roll
 *
 * Both are supported; the caller picks via `mode`.
 */

const DEFAULT_BASE_URL = "https://api.supabase.com";

export interface MgmtClientConfig {
  baseUrl?: string;
  accessToken?: string;
}

export interface MgmtClient {
  baseUrl: string;
  headers: HeadersInit;
}

export function makeClient(cfg: MgmtClientConfig = {}): MgmtClient {
  const token = cfg.accessToken ?? process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN not set — generate a PAT at https://supabase.com/dashboard/account/tokens",
    );
  }
  return {
    baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
}

export interface ProjectSummary {
  id: string;
  organization_id: string;
  name: string;
  region: string;
  status: string;
}

export async function listProjects(client: MgmtClient): Promise<ProjectSummary[]> {
  const res = await fetch(`${client.baseUrl}/v1/projects`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `Supabase Management API /v1/projects returned ${res.status}: ${await safeText(res)}`,
    );
  }
  return (await res.json()) as ProjectSummary[];
}

export interface ApiKey {
  /** Sb scoped keys: id is a UUID. Legacy anon/service_role: id is the role name. */
  id?: string;
  name?: string;
  api_key?: string;
  /** Legacy key roles: "anon" | "service_role" */
  type?: string;
}

export async function listApiKeys(client: MgmtClient, projectRef: string): Promise<ApiKey[]> {
  const res = await fetch(`${client.baseUrl}/v1/projects/${projectRef}/api-keys`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `/v1/projects/${projectRef}/api-keys returned ${res.status}: ${await safeText(res)}`,
    );
  }
  return (await res.json()) as ApiKey[];
}

export interface ProjectKeyMode {
  /** Project is on the new Sb scoped-keys system — mint with scoped-key-mint. */
  supportsScopedKeys: boolean;
  /** Project still uses JWT-based anon + service_role — must use jwt-secret-roll. */
  supportsLegacyJwt: boolean;
  /** Raw count of API keys for diagnostics. */
  keyCount: number;
  /** Names/roles we saw (e.g. "anon", "service_role", or scoped-key UUIDs). */
  keys: { id?: string; name?: string; type?: string }[];
}

/**
 * Inspects the project's API-keys list to decide which rotation mode is
 * compatible. A project that has migrated to scoped keys returns entries
 * with `name`/`id` set (Sb-style); a legacy JWT-only project returns
 * entries with `type: "anon"` / `type: "service_role"`. Many projects
 * have both during the migration window.
 *
 * Caller uses this to either:
 *   - default to scoped-key-mint when supportsScopedKeys=true
 *   - default to jwt-secret-roll when only legacy JWTs exist
 *   - emit a warning when the chosen mode doesn't match the project state
 */
export async function detectKeyMode(
  client: MgmtClient,
  projectRef: string,
): Promise<ProjectKeyMode> {
  const keys = await listApiKeys(client, projectRef);
  let supportsScopedKeys = false;
  let supportsLegacyJwt = false;
  for (const k of keys) {
    if (k.type === "anon" || k.type === "service_role") {
      supportsLegacyJwt = true;
      continue;
    }
    // Sb scoped keys have an id + name + (optional) type "secret"/"publishable"
    if (k.id && (k.type === "secret" || k.type === "publishable" || !k.type)) {
      supportsScopedKeys = true;
    }
  }
  return {
    supportsScopedKeys,
    supportsLegacyJwt,
    keyCount: keys.length,
    keys: keys.map((k) => ({ id: k.id, name: k.name, type: k.type })),
  };
}

export type RotateMode = "jwt-secret-roll" | "scoped-key-mint";

export interface RotateResult {
  mode: RotateMode;
  newKey?: string;
  newJwtSecret?: string;
  /** All keys after rotation, when the provider returns them in one response. */
  rotatedKeys?: ApiKey[];
}

/**
 * Rolls the project's JWT secret. **Invalidates every existing token**
 * (anon, service_role, signed URLs, session JWTs) atomically. Use only
 * when the leak severity warrants a hard cutover.
 */
export async function rollJwtSecret(client: MgmtClient, projectRef: string): Promise<RotateResult> {
  // Endpoint path used by Supabase Dashboard internally (mirrors
  // "Generate new JWT secret" button in Project Settings → API).
  const res = await fetch(`${client.baseUrl}/v1/projects/${projectRef}/config/jwt-secret/roll`, {
    method: "POST",
    headers: client.headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`JWT-secret roll returned ${res.status}: ${await safeText(res)}`);
  }
  const body = (await res.json()) as { jwt_secret?: string; api_keys?: ApiKey[] };
  return {
    mode: "jwt-secret-roll",
    newJwtSecret: body.jwt_secret,
    rotatedKeys: body.api_keys,
  };
}

/**
 * Revokes a previously-minted scoped key by id. The id is the value of
 * the `id` field returned by listApiKeys / mintScopedKey. Legacy JWT
 * roles (anon / service_role) cannot be revoked individually — roll the
 * JWT secret instead.
 */
export async function revokeScopedKey(
  client: MgmtClient,
  projectRef: string,
  keyId: string,
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(
    `${client.baseUrl}/v1/projects/${projectRef}/api-keys/${encodeURIComponent(keyId)}`,
    {
      method: "DELETE",
      headers: client.headers,
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    return {
      ok: false,
      detail: `DELETE /api-keys/${keyId} returned ${res.status}: ${await safeText(res)}`,
    };
  }
  return { ok: true, detail: `revoked key ${keyId}` };
}

/**
 * Mints a fresh scoped secret key (Sb keys API) without invalidating
 * existing tokens — preferred when the project has been migrated to the
 * scoped-keys system (Q1 2026+).
 */
export async function mintScopedKey(
  client: MgmtClient,
  projectRef: string,
  opts: { name?: string; type?: "secret" | "publishable" } = {},
): Promise<RotateResult> {
  // Supabase requires name to match /^[a-z_][a-z0-9_]*$/ — lowercase
  // alphanumerics + underscores, starts with letter or underscore. We
  // build a unix-timestamp slug so the name is unique without colons,
  // hyphens, or uppercase characters.
  const defaultName = `kit_rotated_${Math.floor(Date.now() / 1000)}`;
  const name = (opts.name ?? defaultName).toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const res = await fetch(`${client.baseUrl}/v1/projects/${projectRef}/api-keys`, {
    method: "POST",
    headers: client.headers,
    body: JSON.stringify({
      name,
      type: opts.type ?? "secret",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `/v1/projects/${projectRef}/api-keys returned ${res.status}: ${await safeText(res)}`,
    );
  }
  const key = (await res.json()) as ApiKey;
  return { mode: "scoped-key-mint", newKey: key.api_key };
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return "<no body>";
  }
}
