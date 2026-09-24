/**
 * Stripe Management API client.
 *
 * Stripe does NOT expose programmatic creation of secret/restricted API
 * keys (those live in the dashboard). The automatable surface this plugin
 * targets:
 *   - webhook_endpoints   — create/list/delete; secret returned at creation
 *   - account             — introspection (id, charges_enabled, livemode)
 *
 * Auth: `STRIPE_SECRET_KEY` env var (sk_test_* in test mode, sk_live_* in
 * prod). Mode is auto-detected from the key prefix and surfaced on the
 * client so callers can refuse cross-mode operations.
 */

const DEFAULT_BASE_URL = "https://api.stripe.com";
const API_VERSION = "2024-12-18.acacia";

// Stripe API errors (and the raw HTTP body) can echo back caller-supplied or
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

/**
 * Refuses mutating ops when KIT_READ_ONLY=1 is set. Called from each
 * write surface (createWebhookEndpoint, deleteWebhookEndpoint). Throws so
 * the caller surfaces the refusal explicitly instead of silently no-op'ing.
 */
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

export type StripeMode = "test" | "live" | "restricted" | "unknown";

export interface MgmtClientConfig {
  baseUrl?: string;
  secretKey?: string;
}

export interface MgmtClient {
  baseUrl: string;
  headers: HeadersInit;
  mode: StripeMode;
}

const CLIENT_SECRETS = new WeakMap<MgmtClient, readonly string[]>();

/** Known secrets for this client: the bound key plus whatever the Authorization header
 * carries (covers a client built by hand, not via makeClient). */
function clientSecrets(client: MgmtClient): string[] {
  const authorization = new Headers(client.headers).get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  return [...(CLIENT_SECRETS.get(client) ?? []), ...(bearer ? [bearer] : [])];
}

export function makeClient(cfg: MgmtClientConfig = {}): MgmtClient {
  const secretKey = cfg.secretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY not set — fetch from https://dashboard.stripe.com/apikeys");
  }
  const client = {
    baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": API_VERSION,
      "User-Agent": "sandstream-kit-plugin-stripe",
    },
    mode: detectMode(secretKey),
  };
  CLIENT_SECRETS.set(client, [secretKey]);
  return client;
}

export function detectMode(secretKey: string): StripeMode {
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  if (secretKey.startsWith("rk_test_") || secretKey.startsWith("rk_live_")) return "restricted";
  return "unknown";
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  enabled_events: string[];
  status: "enabled" | "disabled";
  secret?: string;
  created: number;
  livemode: boolean;
}

export interface CreateWebhookEndpointParams {
  url: string;
  enabled_events: string[];
  description?: string;
  metadata?: Record<string, string>;
}

/**
 * Refuses cross-mode webhook creation. The `detectMode()` call surfaces
 * test/live on the client, but Stripe's REST API silently accepts an
 * sk_live key against any URL; without a client-side guard a developer
 * pointing a live key at `https://localhost:3000/...` (or a forgotten
 * staging URL) would happily register a prod webhook that fires its
 * secret on every payment event. The check bails before the request
 * reaches Stripe.
 *
 * `--force` (via `params.force === true`) opts out, but the override is
 * surfaced explicitly so it can't be set silently from a config file.
 */
export function assertModeForUrl(
  client: MgmtClient,
  url: string,
  options: { force?: boolean } = {},
): void {
  if (options.force) return;
  const lower = url.toLowerCase();
  const looksLikeTestHost =
    lower.includes("localhost") ||
    lower.includes("127.0.0.1") ||
    lower.includes("0.0.0.0") ||
    lower.includes(".test/") ||
    lower.includes(".local/") ||
    lower.endsWith(".test") ||
    lower.endsWith(".local") ||
    /:\d{4,5}\b/.test(lower); // any explicit non-standard port is suspect
  if (client.mode === "live" && looksLikeTestHost) {
    throw new Error(
      `Refusing to create LIVE-mode webhook against test-looking URL "${url}". ` +
        `Pass { force: true } to override (and audit-log the decision yourself).`,
    );
  }
  if (client.mode === "test" && !looksLikeTestHost && !lower.startsWith("https://")) {
    throw new Error(
      `Refusing to create TEST-mode webhook against non-HTTPS URL "${url}". ` +
        `Stripe will silently downgrade signature verification. Pass { force: true } to override.`,
    );
  }
}

export async function createWebhookEndpoint(
  client: MgmtClient,
  params: CreateWebhookEndpointParams & { force?: boolean },
): Promise<WebhookEndpoint> {
  assertNotReadOnly("stripe/createWebhookEndpoint");
  assertPolicyAllows("stripe", "webhook_create");
  assertModeForUrl(client, params.url, { force: params.force });
  const body = new URLSearchParams();
  body.set("url", params.url);
  for (const evt of params.enabled_events) {
    body.append("enabled_events[]", evt);
  }
  if (params.description) body.set("description", params.description);
  if (params.metadata) {
    for (const [k, v] of Object.entries(params.metadata)) {
      body.set(`metadata[${k}]`, v);
    }
  }
  const res = await fetch(`${client.baseUrl}/v1/webhook_endpoints`, {
    method: "POST",
    headers: {
      ...(client.headers as Record<string, string>),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `POST /v1/webhook_endpoints returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
  return (await res.json()) as WebhookEndpoint;
}

export async function listWebhookEndpoints(client: MgmtClient): Promise<WebhookEndpoint[]> {
  const res = await fetch(`${client.baseUrl}/v1/webhook_endpoints?limit=100`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `GET /v1/webhook_endpoints returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
  const body = (await res.json()) as { data: WebhookEndpoint[] };
  return body.data ?? [];
}

export async function deleteWebhookEndpoint(
  client: MgmtClient,
  webhookEndpointId: string,
): Promise<void> {
  assertNotReadOnly("stripe/deleteWebhookEndpoint");
  assertPolicyAllows("stripe", "webhook_delete");
  const res = await fetch(
    `${client.baseUrl}/v1/webhook_endpoints/${encodeURIComponent(webhookEndpointId)}`,
    { method: "DELETE", headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `DELETE webhook_endpoint returned ${res.status}: ${await safeText(res, client)}`,
    );
  }
}

export interface AccountSummary {
  id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  country: string;
  default_currency: string;
}

export async function getAccount(client: MgmtClient): Promise<AccountSummary> {
  const res = await fetch(`${client.baseUrl}/v1/account`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET /v1/account returned ${res.status}: ${await safeText(res, client)}`);
  }
  return (await res.json()) as AccountSummary;
}

async function safeText(res: Response, client: MgmtClient): Promise<string> {
  try {
    const t = await res.text();
    return redactErrorText(t, clientSecrets(client)).slice(0, 200);
  } catch {
    return "<no body>";
  }
}
