/**
 * Fly.io Management API client.
 *
 * App secrets have two routes:
 *   - Machines REST API (https://api.machines.dev/v1, spec at
 *     docs.fly.io/api/machines/openapi.json): `listAppSecretsV1`, `setAppSecretsV1`,
 *     `deleteAppSecretV1`. This is the documented API (checked 2026-10-23) and the one to use.
 *   - GraphQL (https://api.fly.io/graphql): `listAppSecrets`, `setAppSecrets`,
 *     `unsetAppSecrets`. Kept for existing callers; Fly's published API reference no longer
 *     covers it.
 * On either route, running Machines do not pick up a change on their own. The REST answer
 * carries the secrets `version` to pass as `min_secrets_version` when Machines are next
 * created or updated; this plugin does not restart anything.
 *
 * Auth: `FLY_API_TOKEN` env var (fly auth token).
 */

const DEFAULT_GRAPHQL_URL = "https://api.fly.io/graphql";
const DEFAULT_MACHINES_URL = "https://api.machines.dev/v1";

// Fly's GraphQL/REST errors (and the raw HTTP body) can echo back caller-supplied
// or provider-side credentials verbatim. Mirrors the redaction the vercel plugin
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
  graphqlUrl?: string;
  machinesUrl?: string;
  token?: string;
}

export interface MgmtClient {
  graphqlUrl: string;
  machinesUrl: string;
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
  const token = cfg.token ?? process.env.FLY_API_TOKEN;
  if (!token) {
    throw new Error("FLY_API_TOKEN not set — run `fly auth token` to fetch one");
  }
  const client = {
    graphqlUrl: cfg.graphqlUrl ?? DEFAULT_GRAPHQL_URL,
    machinesUrl: cfg.machinesUrl ?? DEFAULT_MACHINES_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "sandstream-kit-plugin-fly",
    },
  };
  CLIENT_SECRETS.set(client, [token]);
  return client;
}

async function gql<T>(
  client: MgmtClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(client.graphqlUrl, {
    method: "POST",
    headers: client.headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Fly GraphQL returned ${res.status}: ${await safeText(res, client)}`);
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors && body.errors.length) {
    throw new Error(
      `Fly GraphQL errors: ${redactErrorText(body.errors.map((e) => e.message).join("; "), clientSecrets(client))}`,
    );
  }
  if (!body.data) {
    throw new Error("Fly GraphQL returned no data");
  }
  return body.data;
}

export interface AppSecretSummary {
  name: string;
  digest: string;
  createdAt: string;
}

export async function listAppSecrets(
  client: MgmtClient,
  appName: string,
): Promise<AppSecretSummary[]> {
  const data = await gql<{ app: { secrets: AppSecretSummary[] } }>(
    client,
    `query AppSecrets($appName: String!) {
      app(name: $appName) {
        secrets { name digest createdAt }
      }
    }`,
    { appName },
  );
  return data.app?.secrets ?? [];
}

export interface SetSecretsResult {
  release: { id: string; version: number };
}

export async function setAppSecrets(
  client: MgmtClient,
  appName: string,
  secrets: Record<string, string>,
): Promise<SetSecretsResult> {
  assertNotReadOnly("fly/setAppSecrets");
  assertPolicyAllows("fly", "env_set");
  const entries = Object.entries(secrets).map(([key, value]) => ({ key, value }));
  const data = await gql<{ setSecrets: SetSecretsResult }>(
    client,
    `mutation SetSecrets($input: SetSecretsInput!) {
      setSecrets(input: $input) {
        release { id version }
      }
    }`,
    { input: { appId: appName, secrets: entries } },
  );
  return data.setSecrets;
}

export async function unsetAppSecrets(
  client: MgmtClient,
  appName: string,
  keys: string[],
): Promise<SetSecretsResult> {
  assertNotReadOnly("fly/unsetAppSecrets");
  assertPolicyAllows("fly", "env_unset");
  const data = await gql<{ unsetSecrets: SetSecretsResult }>(
    client,
    `mutation UnsetSecrets($input: UnsetSecretsInput!) {
      unsetSecrets(input: $input) {
        release { id version }
      }
    }`,
    { input: { appId: appName, keys } },
  );
  return data.unsetSecrets;
}

export interface MachineSummary {
  id: string;
  name: string;
  state: string;
  region: string;
}

export async function listMachines(client: MgmtClient, appName: string): Promise<MachineSummary[]> {
  const res = await fetch(`${client.machinesUrl}/apps/${encodeURIComponent(appName)}/machines`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `GET /apps/${appName}/machines returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
  return (await res.json()) as MachineSummary[];
}

export interface AppSecretV1 {
  name: string;
  digest?: string;
  created_at?: string;
  updated_at?: string;
}

/** The app's secrets version after a change; pass as `min_secrets_version` to Machines. */
export interface SecretsVersionV1 {
  version: number;
}

const appSecretsUrl = (client: MgmtClient, appName: string) =>
  `${client.machinesUrl}/apps/${encodeURIComponent(appName)}/secrets`;

/** Names and digests only: `show_secrets` is never requested. */
export async function listAppSecretsV1(
  client: MgmtClient,
  appName: string,
): Promise<AppSecretV1[]> {
  const res = await fetch(appSecretsUrl(client, appName), {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `GET /apps/${appName}/secrets returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
  const body = (await res.json()) as { secrets?: AppSecretV1[] };
  return (body.secrets ?? []).map(({ name, digest, created_at, updated_at }) => ({
    name,
    digest,
    created_at,
    updated_at,
  }));
}

/** Sets one or more app secrets in a single request (POST /v1/apps/{app}/secrets). */
export async function setAppSecretsV1(
  client: MgmtClient,
  appName: string,
  secrets: Record<string, string>,
): Promise<SecretsVersionV1> {
  assertNotReadOnly("fly/setAppSecretsV1");
  assertPolicyAllows("fly", "env_set");
  const res = await fetch(appSecretsUrl(client, appName), {
    method: "POST",
    headers: client.headers,
    body: JSON.stringify({ values: secrets }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `POST /apps/${appName}/secrets returned ${res.status}: ${await safeText(res, client, Object.values(secrets))}`,
    );
  }
  const body = (await res.json()) as { version?: number };
  if (typeof body.version !== "number") {
    throw new Error(`POST /apps/${appName}/secrets: no secrets version in Fly's answer`);
  }
  return { version: body.version };
}

export async function deleteAppSecretV1(
  client: MgmtClient,
  appName: string,
  name: string,
): Promise<SecretsVersionV1> {
  assertNotReadOnly("fly/deleteAppSecretV1");
  assertPolicyAllows("fly", "env_unset");
  const res = await fetch(`${appSecretsUrl(client, appName)}/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: client.headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(
      `DELETE /apps/${appName}/secrets/${name} returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
  const body = (await res.json()) as { version?: number };
  if (typeof body.version !== "number") {
    throw new Error(`DELETE /apps/${appName}/secrets/${name}: no secrets version in Fly's answer`);
  }
  return { version: body.version };
}

async function safeText(
  res: Response,
  client: MgmtClient,
  extraSecrets: readonly string[] = [],
): Promise<string> {
  try {
    const t = await res.text();
    return redactErrorText(t, [...clientSecrets(client), ...extraSecrets]).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
