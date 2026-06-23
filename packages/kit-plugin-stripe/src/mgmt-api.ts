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

/**
 * Refuses mutating ops when KIT_READ_ONLY=1 is set. Called from each
 * write surface (createWebhookEndpoint, deleteWebhookEndpoint). Throws so
 * the caller surfaces the refusal explicitly instead of silently no-op'ing.
 */
function assertNotReadOnly(operation: string): void {
  const v = process.env.KIT_READ_ONLY;
  if (v === "1" || v === "true") {
    throw new Error(`read-only mode active — refusing "${operation}"`);
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

export function makeClient(cfg: MgmtClientConfig = {}): MgmtClient {
  const secretKey = cfg.secretKey ?? process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY not set — fetch from https://dashboard.stripe.com/apikeys");
  }
  return {
    baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": API_VERSION,
      "User-Agent": "sandstream-kit-plugin-stripe",
    },
    mode: detectMode(secretKey),
  };
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
    throw new Error(`POST /v1/webhook_endpoints returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as WebhookEndpoint;
}

export async function listWebhookEndpoints(client: MgmtClient): Promise<WebhookEndpoint[]> {
  const res = await fetch(`${client.baseUrl}/v1/webhook_endpoints?limit=100`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET /v1/webhook_endpoints returned ${res.status}: ${await safeText(res)}`);
  }
  const body = (await res.json()) as { data: WebhookEndpoint[] };
  return body.data ?? [];
}

export async function deleteWebhookEndpoint(
  client: MgmtClient,
  webhookEndpointId: string,
): Promise<void> {
  assertNotReadOnly("stripe/deleteWebhookEndpoint");
  const res = await fetch(
    `${client.baseUrl}/v1/webhook_endpoints/${encodeURIComponent(webhookEndpointId)}`,
    { method: "DELETE", headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`DELETE webhook_endpoint returned ${res.status}: ${await safeText(res)}`);
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
    throw new Error(`GET /v1/account returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as AccountSummary;
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return "<no body>";
  }
}
