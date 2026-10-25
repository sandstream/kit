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
 * JWT signing keys (Supabase's successor to the JWT secret):
 *   GET   /v1/projects/{ref}/config/auth/signing-keys        → list
 *   POST  /v1/projects/{ref}/config/auth/signing-keys        → create (standby)
 *   PATCH /v1/projects/{ref}/config/auth/signing-keys/{id}   → status (in_use, previously_used, revoked)
 *
 * Older projects still use the JWT-secret model where rolling the JWT secret
 * regenerates anon + service_role atomically. That endpoint is an internal dashboard
 * path, absent from the published spec:
 *   POST /v1/projects/{ref}/config/jwt-secret/roll
 */

const DEFAULT_BASE_URL = "https://api.supabase.com";

// Supabase API errors (and the raw HTTP body) can echo back caller-supplied or
// provider-side credentials verbatim. Mirrors the redaction the vercel plugin
// already ships, using the same pattern list, same client-bound known-secrets lookup.
const ERROR_SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9]{20,}/g,
  /\bwhsec_[A-Za-z0-9]{20,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{60,}/g,
  /\bsk-(?:proj|ant|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];

function redactErrorText(input: string, knownSecrets: readonly string[] = []): string {
  let output = input;
  for (const value of [...new Set(knownSecrets)].filter((value) => value.length >= 8)) {
    output = output.split(value).join("[REDACTED]");
  }
  for (const pattern of ERROR_SECRET_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  // Core URL/Bearer parity is tested by src/plugin-error-redaction.test.ts.
  return output
    .replace(/\b([a-z][a-z0-9+.-]{0,15}:\/\/[^\s:@/]{0,128}:)[^\s@/]{3,256}@/gi, "$1[REDACTED]@")
    .replace(/\b([a-z][a-z0-9+.-]{0,15}:\/\/)[A-Za-z0-9._~%+-]{16,256}@/gi, "$1[REDACTED]@")
    .replace(
      /\b((?:token|access_token|api_key|apikey|auth_token|session_token)=)[A-Za-z0-9_\-+/%.]{12,}/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9_\-+/.=]{16,}/gi, "Bearer [REDACTED]");
}

function assertNotReadOnly(operation: string): void {
  const v = process.env.KIT_READ_ONLY;
  if (["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase())) {
    throw new Error(`read-only mode active — refusing "${operation}"`);
  }
}

/**
 * Policy gate for this plugin's write surfaces.
 *
 * kit resolves `[policy.agent_writes]` for the governed project and exports the ops it REFUSES as
 * `KIT_POLICY_DENY` (`vendor:op`, comma-separated). This is a membership test with no rule in it, so
 * there is no policy semantic here that can drift from kit's: the four states — including the
 * `stripe = []` lock and the absent-vendor case that must NOT read as a denial — were all resolved
 * on kit's side before the value was written.
 *
 * Absence of the variable means NO denial. That is the same contract `assertNotReadOnly` lives
 * under, and it is deliberate: inverting it would refuse every op in every project that does not
 * use the block, the moment a plugin ran outside a kit invocation.
 *
 * Ordered AFTER the read-only guard at every call site, so a locked-down repo answers "read-only"
 * rather than "your policy is missing an entry".
 */
function assertPolicyAllows(vendor: string, op: string): void {
  const denied = (process.env.KIT_POLICY_DENY ?? "").split(",");
  if (denied.includes(`${vendor}:${op}`)) {
    throw new Error(
      `refused by [policy.agent_writes.${vendor}] — "${op}" is not pre-approved for this project`,
    );
  }
}

export interface MgmtClientConfig {
  baseUrl?: string;
  accessToken?: string;
}

export interface MgmtClient {
  baseUrl: string;
  headers: HeadersInit;
}

const CLIENT_SECRETS = new WeakMap<MgmtClient, readonly string[]>();

/** Known secrets for this client: the bound token plus whatever the Authorization header
 * carries (covers a client built by hand, not via makeClient). */
function clientSecrets(client: MgmtClient): string[] {
  const authorization = new Headers(client.headers).get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  return [...(CLIENT_SECRETS.get(client) ?? []), ...(bearer ? [bearer] : [])];
}

export function makeClient(cfg: MgmtClientConfig = {}): MgmtClient {
  const token = cfg.accessToken ?? process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "SUPABASE_ACCESS_TOKEN not set — generate a PAT at https://supabase.com/dashboard/account/tokens",
    );
  }
  const client = {
    baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  CLIENT_SECRETS.set(client, [token]);
  return client;
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
      `Supabase Management API /v1/projects returned ${res.status}: ${await safeText(res, client)}`,
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
      `/v1/projects/${projectRef}/api-keys returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
  return (await res.json()) as ApiKey[];
}

export interface ProjectKeyMode {
  /** Project is on the new Sb scoped-keys system — mint with scoped-key-mint. */
  supportsScopedKeys: boolean;
  /** Project still uses JWT-based anon + service_role: scoped-key-mint would break it. */
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
 *
 * LEGACY. This path is absent from Supabase's published Management API spec
 * (api.supabase.com/api/v1-json, checked 2026-10-23): Supabase moved JWT signing to
 * signing keys, and marks its remaining legacy endpoints "will be removed in the future".
 * Prefer `rotateSigningKey`, which is reversible.
 */
export async function rollJwtSecret(client: MgmtClient, projectRef: string): Promise<RotateResult> {
  assertNotReadOnly("supabase/rollJwtSecret");
  assertPolicyAllows("supabase", "jwt_secret_roll");
  // Endpoint path used by Supabase Dashboard internally (mirrors
  // "Generate new JWT secret" button in Project Settings → API).
  const res = await fetch(`${client.baseUrl}/v1/projects/${projectRef}/config/jwt-secret/roll`, {
    method: "POST",
    headers: client.headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`JWT-secret roll returned ${res.status}: ${await safeText(res, client)}`);
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
  assertNotReadOnly("supabase/revokeScopedKey");
  assertPolicyAllows("supabase", "scoped_key_revoke");
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
      detail: `DELETE /api-keys/${keyId} returned ${res.status}: ${await safeText(res, client)}`,
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
  assertNotReadOnly("supabase/mintScopedKey");
  assertPolicyAllows("supabase", "scoped_key_mint");
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
      `/v1/projects/${projectRef}/api-keys returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
  const key = (await res.json()) as ApiKey;
  return { mode: "scoped-key-mint", newKey: key.api_key };
}

export type SigningKeyAlgorithm = "EdDSA" | "ES256" | "RS256" | "HS256";
export type SigningKeyStatus = "in_use" | "previously_used" | "revoked" | "standby";

/** A JWT signing key as the Management API returns it. Only the public JWK is ever exposed. */
export interface SigningKey {
  id: string;
  algorithm: SigningKeyAlgorithm;
  status: SigningKeyStatus;
  public_jwk?: unknown;
  created_at?: string;
  updated_at?: string;
}

const signingKeysPath = (client: MgmtClient, projectRef: string) =>
  `${client.baseUrl}/v1/projects/${encodeURIComponent(projectRef)}/config/auth/signing-keys`;

export async function listSigningKeys(
  client: MgmtClient,
  projectRef: string,
): Promise<SigningKey[]> {
  const res = await fetch(signingKeysPath(client, projectRef), {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET signing-keys returned ${res.status}: ${await safeText(res, client)}`);
  }
  const body = (await res.json()) as { keys?: SigningKey[] };
  return body.keys ?? [];
}

export interface SigningKeyRotation {
  /** The key now signing new JWTs. */
  activated: SigningKey;
  /** Keys moved from in_use to previously_used. They still verify tokens they signed. */
  demoted: SigningKey[];
}

/**
 * Rotates the project's JWT signing key the way Supabase's signing-keys system intends:
 * create a key in standby, make it in_use, then move whatever else was in_use to
 * previously_used. REVERSIBLE: a previously_used key keeps verifying the tokens it signed and
 * can be made in_use again. Nothing is revoked here; that is `revokeSigningKey`, on purpose.
 *
 * Order matters: the new key is activated BEFORE the old one is demoted, so the project never
 * has zero keys in use. If activation fails, the new key is left in standby, which is harmless.
 */
export async function rotateSigningKey(
  client: MgmtClient,
  projectRef: string,
  opts: { algorithm?: SigningKeyAlgorithm } = {},
): Promise<SigningKeyRotation> {
  assertNotReadOnly("supabase/rotateSigningKey");
  assertPolicyAllows("supabase", "signing_key_rotate");
  const base = signingKeysPath(client, projectRef);
  const send = async (url: string, method: "POST" | "PATCH", body: object, what: string) => {
    const res = await fetch(url, {
      method,
      headers: client.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`${what} returned ${res.status}: ${await safeText(res, client)}`);
    return (await res.json()) as SigningKey;
  };

  const before = await listSigningKeys(client, projectRef);
  const created = await send(
    base,
    "POST",
    { algorithm: opts.algorithm ?? "ES256", status: "standby" },
    "create standby signing key",
  );
  const activated = await send(
    `${base}/${encodeURIComponent(created.id)}`,
    "PATCH",
    { status: "in_use" },
    `activate signing key ${created.id}`,
  );
  const demoted: SigningKey[] = [];
  for (const key of before.filter((k) => k.status === "in_use" && k.id !== created.id)) {
    demoted.push(
      await send(
        `${base}/${encodeURIComponent(key.id)}`,
        "PATCH",
        { status: "previously_used" },
        `demote signing key ${key.id}`,
      ),
    );
  }
  return { activated, demoted };
}

/**
 * Revokes one signing key: tokens it signed stop verifying. Refuses the key that is in_use,
 * because revoking it would leave the project signing with nothing; rotate first.
 */
export async function revokeSigningKey(
  client: MgmtClient,
  projectRef: string,
  keyId: string,
): Promise<SigningKey> {
  assertNotReadOnly("supabase/revokeSigningKey");
  assertPolicyAllows("supabase", "signing_key_revoke");
  const current = (await listSigningKeys(client, projectRef)).find((k) => k.id === keyId);
  if (!current) throw new Error(`signing key ${keyId} not found in project ${projectRef}`);
  if (current.status === "in_use") {
    throw new Error(`refusing to revoke ${keyId}: it is the key in use — rotate first`);
  }
  const res = await fetch(`${signingKeysPath(client, projectRef)}/${encodeURIComponent(keyId)}`, {
    method: "PATCH",
    headers: client.headers,
    body: JSON.stringify({ status: "revoked" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `revoke signing key ${keyId} returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
  return (await res.json()) as SigningKey;
}

async function safeText(res: Response, client: MgmtClient): Promise<string> {
  try {
    const t = await res.text();
    return redactErrorText(t, clientSecrets(client)).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
