/**
 * MCP servers configured on loopback HTTP with no token in their config.
 *
 * A server on `http://127.0.0.1`, `localhost` or `[::1]` is reachable from every local process
 * and, unless it checks `Host` and `Origin`, from any web page the user opens: a page can send a
 * simple cross-origin POST, or rebind a DNS name to 127.0.0.1 (kit-research
 * `agent-first-localhost-guide-vs-kit`; scanners already probe `/mcp`, `huginn-honeypot-vs-kit`).
 * The agent audit's loopback row says kit cannot see what such a server binds to. This row adds
 * what the config does show: whether the client sends any credential at all.
 *
 * Reads the JSON MCP configs the project agent audit reads. Read-only; never prints a header value.
 */
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { isLoopbackUrl } from "./agent-audit.js";
import { readInstructionFile } from "./instruction-scan-files.js";

/** The JSON files among the project agent audit's configs that can declare MCP servers. */
const MCP_CONFIGS = [
  ".mcp.json",
  ".claude.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  "opencode.json",
  "opencode.jsonc",
  ".codex/config.json",
];

/** A header or field name that carries a credential. */
const CREDENTIAL_NAME =
  /^(authorization|proxy-authorization|cookie)$|token|api[-_]?key|secret|auth/i;

/** Fields that configure auth for the whole server rather than one header. */
const AUTH_FIELDS = [
  "headersHelper",
  "oauth",
  "auth",
  "bearer_token_env_var",
  "bearerToken",
  "token",
  "apiKey",
];

function nonEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

function headersCarryCredential(headers: unknown): boolean {
  if (!headers || typeof headers !== "object") return false;
  return Object.entries(headers as Record<string, unknown>).some(
    ([name, value]) => CREDENTIAL_NAME.test(name) && nonEmpty(value),
  );
}

function urlCarriesCredential(url: URL): boolean {
  if (url.username || url.password) return true;
  return [...url.searchParams.keys()].some((k) => CREDENTIAL_NAME.test(k));
}

/** True when a server definition sends any credential: a header, an auth field or one in the URL. */
function hasCredential(def: Record<string, unknown>, url: URL): boolean {
  const init = def.requestInit as { headers?: unknown } | undefined;
  return (
    AUTH_FIELDS.some((f) => nonEmpty(def[f])) ||
    headersCarryCredential(def.headers) ||
    headersCarryCredential(def.http_headers) ||
    headersCarryCredential(init?.headers) ||
    urlCarriesCredential(url)
  );
}

function serverUrl(def: Record<string, unknown>): string | null {
  for (const key of ["url", "serverUrl", "httpUrl"]) {
    if (typeof def[key] === "string") return def[key];
  }
  return null;
}

/** `name → url` for each loopback `http:` MCP server in `json` that sends no credential. Pure. */
export function loopbackServersWithoutToken(json: string): string[] {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return [];
  }
  const o = obj as Record<string, unknown> | null;
  const containers = [o?.mcpServers, o?.servers, o?.mcp].filter(
    (c): c is Record<string, unknown> => !!c && typeof c === "object",
  );
  const out: string[] = [];
  for (const servers of containers) {
    for (const [name, raw] of Object.entries(servers)) {
      if (!raw || typeof raw !== "object") continue;
      const def = raw as Record<string, unknown>;
      const text = serverUrl(def);
      if (text === null || !isLoopbackUrl(text)) continue;
      const url = new URL(text);
      if (url.protocol !== "http:" || hasCredential(def, url)) continue;
      out.push(`${name} → ${url.origin}${url.pathname}`);
    }
  }
  return out;
}

/** One warn row per config file that declares a loopback HTTP MCP server with no credential. */
export function checkMcpLoopbackToken(root: string): SecurityCheckResult[] {
  const rows: SecurityCheckResult[] = [];
  for (const rel of MCP_CONFIGS) {
    const body = readInstructionFile(join(root, ...rel.split("/")));
    if (body === null) continue;
    const hits = loopbackServersWithoutToken(body);
    if (hits.length === 0) continue;
    rows.push({
      category: "exposure",
      name: `loopback MCP without a token in ${rel}`,
      status: "warn",
      severity: "medium",
      detail: `${hits.length} MCP server(s) on loopback http:// with no auth header or token in the config: ${hits.join("; ")}. Any web page the user opens can send it requests unless the server checks Host and Origin`,
      suggestion:
        "have the server require a token and send it in the config's headers (Authorization), or confirm the server rejects requests whose Host or Origin is not its own",
    });
  }
  return rows;
}
