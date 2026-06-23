/**
 * Cloudflare Management API client.
 *
 * Surface kit uses:
 *   - Workers script secrets   PUT/GET/DELETE /accounts/{acct}/workers/scripts/{name}/secrets
 *   - API tokens (read + revoke)              /user/tokens, /user/tokens/{id}
 *
 * Auth: `CLOUDFLARE_API_TOKEN` env var with the relevant scopes
 *       (Workers Scripts:Edit, User API Tokens:Edit).
 *
 * Note: Cloudflare API tokens cannot be *created* via the user-token API
 * with arbitrary scopes — that path requires the account-level scoped
 * token API, which is restricted. This plugin therefore focuses on the
 * surfaces that are universally automatable: workers-secrets (full CRUD)
 * and tokens (read + revoke).
 */

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

function assertNotReadOnly(operation: string): void {
  const v = process.env.KIT_READ_ONLY;
  if (v === "1" || v === "true") {
    throw new Error(`read-only mode active — refusing "${operation}"`);
  }
}

export interface MgmtClientConfig {
  baseUrl?: string;
  apiToken?: string;
  accountId?: string;
}

export interface MgmtClient {
  baseUrl: string;
  headers: HeadersInit;
  accountId?: string;
}

export function makeClient(cfg: MgmtClientConfig = {}): MgmtClient {
  const apiToken = cfg.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "CLOUDFLARE_API_TOKEN not set — create one at https://dash.cloudflare.com/profile/api-tokens",
    );
  }
  return {
    baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "User-Agent": "sandstream-kit-plugin-cloudflare",
    },
    accountId: cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID,
  };
}

function requireAccountId(client: MgmtClient): string {
  if (!client.accountId) {
    throw new Error(
      "accountId required — pass via makeClient({ accountId }) or set CLOUDFLARE_ACCOUNT_ID",
    );
  }
  return client.accountId;
}

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

async function cfFetch<T>(client: MgmtClient, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${client.baseUrl}${path}`, {
    ...init,
    headers: { ...(client.headers as Record<string, string>), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `${init.method ?? "GET"} ${path} returned ${res.status}: ${await safeText(res)}`,
    );
  }
  const envelope = (await res.json()) as CfEnvelope<T>;
  if (!envelope.success) {
    const msg = (envelope.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    // "(no detail)" instead of "<no detail>" — semgrep's
    // raw-html-format rule false-positives on the angle brackets.
    throw new Error(`Cloudflare API error on ${path}: ${msg || "(no detail)"}`);
  }
  return envelope.result;
}

export interface WorkerSecretSummary {
  name: string;
  type: "secret_text" | "secret_key";
}

export async function listWorkerSecrets(
  client: MgmtClient,
  scriptName: string,
): Promise<WorkerSecretSummary[]> {
  const accountId = requireAccountId(client);
  return cfFetch<WorkerSecretSummary[]>(
    client,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
  );
}

export interface PutWorkerSecretParams {
  name: string;
  text: string;
  type?: "secret_text" | "secret_key";
}

export async function putWorkerSecret(
  client: MgmtClient,
  scriptName: string,
  params: PutWorkerSecretParams,
): Promise<WorkerSecretSummary> {
  assertNotReadOnly("cloudflare/putWorkerSecret");
  const accountId = requireAccountId(client);
  return cfFetch<WorkerSecretSummary>(
    client,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets`,
    {
      method: "PUT",
      body: JSON.stringify({
        name: params.name,
        text: params.text,
        type: params.type ?? "secret_text",
      }),
    },
  );
}

export async function deleteWorkerSecret(
  client: MgmtClient,
  scriptName: string,
  secretName: string,
): Promise<void> {
  assertNotReadOnly("cloudflare/deleteWorkerSecret");
  const accountId = requireAccountId(client);
  await cfFetch<unknown>(
    client,
    `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/secrets/${encodeURIComponent(secretName)}`,
    { method: "DELETE" },
  );
}

export interface ApiTokenSummary {
  id: string;
  name: string;
  status: "active" | "disabled" | "expired";
  issued_on: string;
  modified_on: string;
  expires_on?: string;
}

export async function listApiTokens(client: MgmtClient): Promise<ApiTokenSummary[]> {
  return cfFetch<ApiTokenSummary[]>(client, "/user/tokens");
}

export async function revokeApiToken(client: MgmtClient, tokenId: string): Promise<void> {
  assertNotReadOnly("cloudflare/revokeApiToken");
  await cfFetch<unknown>(client, `/user/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return "<no body>";
  }
}
