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

function assertNotReadOnly(operation: string): void {
  const v = process.env.KIT_READ_ONLY;
  if (v === "1" || v === "true") {
    throw new Error(`read-only mode active — refusing "${operation}"`);
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

export function makeClient(cfg: MgmtClientConfig = {}): MgmtClient {
  const token = cfg.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN not set — generate a fine-grained PAT at https://github.com/settings/personal-access-tokens",
    );
  }
  return {
    baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "sandstream-kit-plugin-github",
    },
  };
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
  const res = await fetch(
    `${client.baseUrl}/repos/${owner}/${repo}/actions/secrets`,
    { headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    throw new Error(
      `GET /repos/${owner}/${repo}/actions/secrets returned ${res.status}: ${await safeText(res)}`,
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
  const res = await fetch(
    `${client.baseUrl}/repos/${owner}/${repo}/actions/secrets/public-key`,
    { headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    throw new Error(`GET .../public-key returned ${res.status}: ${await safeText(res)}`);
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
    throw new Error(`PUT secret returned ${res.status}: ${await safeText(res)}`);
  }
}

export async function deleteRepoSecret(
  client: MgmtClient,
  owner: string,
  repo: string,
  secretName: string,
): Promise<void> {
  assertNotReadOnly("github/deleteRepoSecret");
  const res = await fetch(
    `${client.baseUrl}/repos/${owner}/${repo}/actions/secrets/${encodeURIComponent(secretName)}`,
    { method: "DELETE", headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE secret returned ${res.status}: ${await safeText(res)}`);
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
  const res = await fetch(
    `${client.baseUrl}/repos/${owner}/${repo}/keys`,
    { headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    throw new Error(`GET .../keys returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as DeployKey[];
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return "<no body>";
  }
}
