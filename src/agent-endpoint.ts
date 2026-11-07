/**
 * Model endpoints redirected away from the vendor.
 *
 * One variable sends every prompt, every tool result and every secret an agent reads to another
 * host: `ANTHROPIC_BASE_URL` for Claude Code, `OPENAI_BASE_URL` for Codex and the OpenAI SDKs.
 * People set it on purpose (a gateway, a logging proxy, a router across accounts), and a planted
 * `env` block in `.claude/settings.json` can set it silently. Either way the host at the other end
 * sees everything, so kit names it.
 *
 * Like `agent-preload`, this cannot tell a chosen gateway from a planted one: it reports the host,
 * never the full URL (a URL can carry a key), and never a token variable's value.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { claudeEnvSources } from "./agent-preload.js";

/** Endpoint variables and the host suffixes that belong to the vendor they point at. */
export const ENDPOINT_VARS: { name: string; vendor: string[] }[] = [
  { name: "ANTHROPIC_BASE_URL", vendor: ["api.anthropic.com"] },
  { name: "ANTHROPIC_BEDROCK_BASE_URL", vendor: [".amazonaws.com"] },
  { name: "ANTHROPIC_VERTEX_BASE_URL", vendor: [".googleapis.com"] },
  { name: "OPENAI_BASE_URL", vendor: ["api.openai.com", ".openai.azure.com"] },
  { name: "OPENAI_API_BASE", vendor: ["api.openai.com", ".openai.azure.com"] },
];

export type EndpointKind = "vendor" | "loopback" | "third-party" | "cleartext" | "invalid";

export interface EndpointFinding {
  variable: string;
  /** The host only; `-` when the value is not a URL. */
  host: string;
  kind: EndpointKind;
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function matchesVendor(host: string, vendor: string[]): boolean {
  const h = host.toLowerCase();
  return vendor.some((v) => (v.startsWith(".") ? h.endsWith(v) : h === v));
}

/** What one endpoint value points at. Pure. */
export function classifyEndpoint(
  value: string,
  vendor: string[],
): Omit<EndpointFinding, "variable"> {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { host: "-", kind: "invalid" };
  }
  const host = url.hostname;
  if (isLoopbackHost(host)) return { host, kind: "loopback" };
  if (url.protocol !== "https:") return { host, kind: "cleartext" };
  return { host, kind: matchesVendor(host, vendor) ? "vendor" : "third-party" };
}

/** Every endpoint variable in `env` that does not point at its vendor over HTTPS. Pure. */
export function auditEndpointEnv(env: Record<string, unknown>): EndpointFinding[] {
  const out: EndpointFinding[] = [];
  for (const { name, vendor } of ENDPOINT_VARS) {
    const v = env[name];
    if (typeof v !== "string" || v.trim() === "") continue;
    const c = classifyEndpoint(v, vendor);
    if (c.kind !== "vendor") out.push({ variable: name, ...c });
  }
  return out;
}

const ROW: Record<
  Exclude<EndpointKind, "vendor">,
  Pick<SecurityCheckResult, "status" | "severity"> & { why: string }
> = {
  cleartext: {
    status: "fail",
    severity: "high",
    why: "over plain HTTP: every prompt, tool result and secret crosses the network unencrypted",
  },
  "third-party": {
    status: "warn",
    severity: "medium",
    why: "a host that is not the vendor's receives every prompt, tool result and secret the agent reads",
  },
  loopback: {
    status: "warn",
    severity: "low",
    why: "a local process (a gateway or logging proxy) receives every prompt, tool result and secret",
  },
  invalid: {
    status: "warn",
    severity: "low",
    why: "the value is not a URL, so the client's behaviour is undefined",
  },
};

/** One row per redirected endpoint, from the process environment and Claude settings. */
export function runAgentEndpoint(
  root: string,
  home: string,
  env: Record<string, unknown>,
): SecurityCheckResult[] {
  const rows: SecurityCheckResult[] = [];
  for (const s of claudeEnvSources(root, home, env)) {
    if (!s.env) continue;
    for (const f of auditEndpointEnv(s.env)) {
      const r = ROW[f.kind as Exclude<EndpointKind, "vendor">];
      rows.push({
        category: "exposure",
        name: `${f.variable} points at ${f.host} (${s.where})`,
        status: r.status,
        severity: r.severity,
        detail: `${f.variable} sends model traffic ${r.why}`,
        suggestion:
          "confirm you set this and who runs that host; kit cannot tell a chosen gateway from a planted one",
      });
    }
  }
  return rows;
}
