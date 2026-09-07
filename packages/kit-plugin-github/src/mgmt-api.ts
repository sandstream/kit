/**
 * Minimal GitHub REST API client focused on the surface kit actually
 * uses: repo + org Actions secrets, deploy keys, and workflow-run
 * inspection.
 *
 * Auth: `GITHUB_TOKEN` env var. Fine-grained PATs with the
 *   - Repository: Secrets (read/write)
 *   - Repository: Actions (read)
 *   - Repository: Administration (for deploy keys)
 * scopes cover the implemented surface.
 *
 * GitHub does not currently expose programmatic PAT creation/rotation,
 * so PAT lifecycle remains a UI flow. This plugin focuses on the parts
 * that ARE automatable.
 *
 * Secret writes use libsodium SealedBox encryption (the official "encrypt
 * the value using LibSodium and your repository's public key" flow).
 * Node 22 doesn't have sealedbox in core; we fall back to a pure-JS
 * sodium-native equivalent using Node's tweetnacl-compatible crypto if
 * the optional `libsodium-wrappers` peer is installed — otherwise
 * createOrUpdateSecret throws with a clear install hint.
 */

const DEFAULT_BASE_URL = "https://api.github.com";

// GitHub API errors (and the raw HTTP body) can echo back caller-supplied or
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
  return output
    .replace(/\b([a-z][a-z0-9+.-]{0,15}:\/\/[^\s:@/]{0,128}:)[^\s@/]{3,256}@/gi, "$1[REDACTED]@")
    .replace(/\b([a-z][a-z0-9+.-]{0,15}:\/\/)[A-Za-z0-9._~%+-]{16,256}@/gi, "$1[REDACTED]@");
}

function assertNotReadOnly(operation: string): void {
  const v = process.env.KIT_READ_ONLY;
  if (v === "1" || v === "true") {
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
  token?: string;
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
  const token = cfg.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN not set — generate a fine-grained PAT at https://github.com/settings/personal-access-tokens",
    );
  }
  const client = {
    baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sandstream-kit-plugin-github",
    },
  };
  CLIENT_SECRETS.set(client, [token]);
  return client;
}

export interface RepoSecretSummary {
  name: string;
  created_at: string;
  updated_at: string;
}

export async function listRepoSecrets(
  client: MgmtClient,
  owner: string,
  repo: string,
): Promise<RepoSecretSummary[]> {
  const res = await fetch(`${client.baseUrl}/repos/${owner}/${repo}/actions/secrets`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `GET /repos/${owner}/${repo}/actions/secrets returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
  const body = (await res.json()) as { secrets: RepoSecretSummary[] };
  return body.secrets ?? [];
}

export interface RepoPublicKey {
  key_id: string;
  key: string;
}

async function getRepoPublicKey(
  client: MgmtClient,
  owner: string,
  repo: string,
): Promise<RepoPublicKey> {
  const res = await fetch(`${client.baseUrl}/repos/${owner}/${repo}/actions/secrets/public-key`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET .../public-key returned ${res.status}: ${await safeText(res, client)}`);
  }
  return (await res.json()) as RepoPublicKey;
}

/**
 * Encrypts `value` with the repo's public key (libsodium SealedBox).
 *
 * Lazy-loads `libsodium-wrappers`. Caller must install it as a dep:
 *
 *     npm install libsodium-wrappers
 *
 * (We don't list it in package.json's "dependencies" so kit-core
 * boot stays small — the plugin only needs it when actually creating
 * secrets, not just reading.)
 */
interface SodiumLike {
  ready: Promise<void>;
  base64_variants: { ORIGINAL: number };
  from_base64(input: string, variant: number): Uint8Array;
  from_string(input: string): Uint8Array;
  to_base64(bytes: Uint8Array, variant: number): string;
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
}

async function encryptForRepo(publicKeyBase64: string, value: string): Promise<string> {
  let sodium: SodiumLike;
  try {
    const mod = (await import(/* @vite-ignore */ "libsodium-wrappers" as string)) as {
      default?: SodiumLike;
    } & SodiumLike;
    sodium = mod.default ?? mod;
  } catch {
    throw new Error(
      "libsodium-wrappers not installed — run `npm install libsodium-wrappers` " +
        "to enable GitHub secret writes (read-only ops work without it).",
    );
  }
  await sodium.ready;
  const keyBytes = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const messageBytes = sodium.from_string(value);
  const encrypted = sodium.crypto_box_seal(messageBytes, keyBytes);
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

export async function createOrUpdateRepoSecret(
  client: MgmtClient,
  owner: string,
  repo: string,
  secretName: string,
  value: string,
): Promise<void> {
  assertNotReadOnly("github/createOrUpdateRepoSecret");
  assertPolicyAllows("github", "env_set");
  const publicKey = await getRepoPublicKey(client, owner, repo);
  const encryptedValue = await encryptForRepo(publicKey.key, value);
  const res = await fetch(
    `${client.baseUrl}/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(secretName)}`,
    {
      method: "PUT",
      headers: client.headers,
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: publicKey.key_id,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    throw new Error(`PUT secret returned ${res.status}: ${await safeText(res, client)}`);
  }
}

export async function deleteRepoSecret(
  client: MgmtClient,
  owner: string,
  repo: string,
  secretName: string,
): Promise<void> {
  assertNotReadOnly("github/deleteRepoSecret");
  assertPolicyAllows("github", "env_unset");
  const res = await fetch(
    `${client.baseUrl}/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(secretName)}`,
    { method: "DELETE", headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE secret returned ${res.status}: ${await safeText(res, client)}`);
  }
}

export interface DeployKey {
  id: number;
  key: string;
  title: string;
  read_only: boolean;
  created_at: string;
}

export async function listDeployKeys(
  client: MgmtClient,
  owner: string,
  repo: string,
): Promise<DeployKey[]> {
  const res = await fetch(`${client.baseUrl}/repos/${owner}/${repo}/keys`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET .../keys returned ${res.status}: ${await safeText(res, client)}`);
  }
  return (await res.json()) as DeployKey[];
}

async function safeText(res: Response, client: MgmtClient): Promise<string> {
  try {
    const t = await res.text();
    return redactErrorText(t, clientSecrets(client)).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
