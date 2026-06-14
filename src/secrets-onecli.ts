/**
 * OneCLI integration (https://github.com/onecli/onecli).
 *
 * OneCLI is a local HTTP gateway that intercepts outbound agent requests and
 * injects credentials. Agents see a placeholder; the gateway swaps it for the
 * real value at egress. This module lets `kit secrets` register entries
 * with OneCLI directly, so the real credential lives in OneCLI's encrypted
 * store and never reaches the agent process.
 *
 * Auth: API key in `ONECLI_API_KEY` (Bearer oc_*) — generate from the web UI
 * at http://localhost:10254/settings/api-keys before first use.
 */

import { randomBytes } from "node:crypto";

const DEFAULT_API_URL = "http://127.0.0.1:10254";
const DEFAULT_GATEWAY_URL = "http://127.0.0.1:10255";

export interface OneCliConfig {
  apiUrl: string;
  gatewayUrl: string;
  apiKey?: string;
}

export function resolveOneCliConfig(): OneCliConfig {
  return {
    apiUrl: process.env.ONECLI_API_URL || DEFAULT_API_URL,
    gatewayUrl: process.env.ONECLI_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    apiKey: process.env.ONECLI_API_KEY,
  };
}

export interface OneCliStatus {
  reachable: boolean;
  authenticated: boolean;
  apiUrl: string;
  gatewayUrl: string;
  version?: string;
  error?: string;
}

export async function checkOneCliStatus(
  cfg: OneCliConfig = resolveOneCliConfig(),
): Promise<OneCliStatus> {
  const status: OneCliStatus = {
    reachable: false,
    authenticated: false,
    apiUrl: cfg.apiUrl,
    gatewayUrl: cfg.gatewayUrl,
  };

  try {
    const res = await fetch(`${cfg.apiUrl}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      status.error = `health check returned ${res.status}`;
      return status;
    }
    status.reachable = true;
    const body = (await res.json().catch(() => null)) as {
      version?: string;
    } | null;
    if (body?.version) status.version = body.version;
  } catch (err: unknown) {
    status.error = err instanceof Error ? err.message : String(err);
    return status;
  }

  if (!cfg.apiKey) {
    status.error =
      "ONECLI_API_KEY not set — generate one at /settings/api-keys";
    return status;
  }

  try {
    const res = await fetch(`${cfg.apiUrl}/api/user`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(3000),
    });
    status.authenticated = res.ok;
    if (!res.ok) status.error = `auth check returned ${res.status}`;
  } catch (err: unknown) {
    status.error = err instanceof Error ? err.message : String(err);
  }

  return status;
}

export interface RegisterSecretInput {
  /** Display name in OneCLI (typically the env-var name, e.g. STRIPE_SECRET_KEY) */
  name: string;
  /** The real credential value to store encrypted */
  value: string;
  /** Hostname pattern (no scheme, no path) — e.g. "api.stripe.com" */
  hostPattern: string;
  /** Optional path pattern (e.g. "/v1/*") */
  pathPattern?: string;
  /**
   * Where to inject the value. Default mirrors most APIs:
   * `{ headerName: "Authorization", valueFormat: "Bearer {value}" }`.
   * Pass null to use OneCLI's automatic detection.
   */
  injectionConfig?: { headerName: string; valueFormat?: string } | null;
}

export interface RegisterSecretResult {
  id: string;
  name: string;
}

/**
 * Registers a secret with OneCLI. Returns the created secret's id.
 *
 * Caller is responsible for writing a placeholder to `.env.local` separately —
 * OneCLI doesn't generate or return one, since the gateway matches by host
 * pattern, not by placeholder value.
 */
export async function registerSecretInOneCli(
  input: RegisterSecretInput,
  cfg: OneCliConfig = resolveOneCliConfig(),
): Promise<RegisterSecretResult> {
  if (!cfg.apiKey) {
    throw new Error(
      "ONECLI_API_KEY not set — generate one in OneCLI's UI (Settings → API Keys)",
    );
  }
  const body = {
    name: input.name,
    type: "generic" as const,
    value: input.value,
    hostPattern: input.hostPattern,
    pathPattern: input.pathPattern,
    injectionConfig: input.injectionConfig ?? {
      headerName: "Authorization",
      valueFormat: "Bearer {value}",
    },
  };
  const res = await fetch(`${cfg.apiUrl}/api/secrets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OneCLI POST /api/secrets returned ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { id: string; name: string };
  return { id: json.id, name: json.name };
}

/**
 * Generates a placeholder value to write into `.env.local`. The actual value
 * is irrelevant to OneCLI — the gateway matches by host pattern — but a
 * recognizable prefix (`PCLI_`) helps grep/audit tooling identify which
 * env vars are gateway-routed.
 */
export function generatePlaceholder(): string {
  return `PCLI_${randomBytes(12).toString("base64url")}`;
}
