/**
 * MCP orchestrator — declarative auth + status for the MCP servers a
 * project uses. The contract:
 *
 *   `.kit.toml`:
 *     [mcp.sentry]
 *     region = "de"
 *     scopes = ["org:read", "project:write", "event:write"]
 *
 *     [mcp.stripe]
 *     scopes = ["webhooks:write"]
 *
 *   $ kit mcp list                  # show declared + auth state
 *   $ kit mcp status                # one-line per MCP: ok / expired / missing
 *   $ kit mcp auth <name>           # browser-OAuth then stash token in vault
 *
 * Tokens land in `~/.kit/mcp-tokens.json` (chmod 0o600) keyed by MCP
 * server name. kit-plugins read from the same path so the CLI and the
 * plugin clients share one source of truth without exposing raw tokens
 * across module boundaries.
 *
 * This file is the orchestration layer ONLY — actual OAuth flows are
 * delegated to vendor-specific helpers in the plugin packages (or to the
 * MCP cloud-host's standard `/authorize` endpoint).
 */

import { readFile, writeFile, mkdir, rename, access, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { McpConfig, McpServerConfig } from "./config.js";
import { secureFile, secureDir } from "./utils/secure-perms.js";

const TOKEN_FILE = `${homedir()}/.kit/mcp-tokens.json`;

export interface McpToken {
  /** Bearer token issued by the MCP server. */
  accessToken: string;
  /** Optional refresh token (Sentry, Atlassian, etc.). */
  refreshToken?: string;
  /** ISO timestamp when accessToken expires (best-effort). */
  expiresAt?: string;
  /** Scopes the issued token covers. */
  scopes?: string[];
  /** Account / org id the token is bound to. */
  subject?: string;
}

type TokenStore = Record<string, McpToken>;

async function readTokenStore(): Promise<TokenStore> {
  try {
    const raw = await readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(raw) as TokenStore;
  } catch {
    return {};
  }
}

async function writeTokenStore(store: TokenStore): Promise<void> {
  // Atomic write with mode-on-create. Avoids a race window where the file
  // would briefly exist with default permissions (typically 0o644) before
  // chmod tightens it. mkdir(... mode: 0o700) keeps the parent dir
  // owner-only too — defense in depth for the token store.
  const dir = dirname(TOKEN_FILE);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  secureDir(dir); // Windows: NTFS ignores mode bits — enforce owner-only via ACL (#43)
  const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
  try {
    // wx flag = fail if exists (no clobber); mode passed to open() so the
    // tmp file is 0o600 from the very first byte.
    await writeFile(tmp, JSON.stringify(store, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(tmp, TOKEN_FILE);
    secureFile(TOKEN_FILE); // owner-only on Windows too (#43)
  } catch (err) {
    // Cleanup tmp if rename failed.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function getMcpToken(name: string): Promise<McpToken | null> {
  const store = await readTokenStore();
  return store[name] ?? null;
}

export async function setMcpToken(name: string, token: McpToken): Promise<void> {
  const store = await readTokenStore();
  store[name] = token;
  await writeTokenStore(store);
}

export async function clearMcpToken(name: string): Promise<void> {
  const store = await readTokenStore();
  delete store[name];
  await writeTokenStore(store);
}

export type McpAuthStatus = "ok" | "expired" | "missing" | "scope-mismatch" | "unconfigured";

export interface McpStatusEntry {
  name: string;
  declared: McpServerConfig | null;
  status: McpAuthStatus;
  expiresAt?: string;
  scopes?: string[];
  detail?: string;
}

export async function statusForMcp(
  name: string,
  declared: McpServerConfig | null,
): Promise<McpStatusEntry> {
  if (!declared) {
    return { name, declared: null, status: "unconfigured", detail: "not in .kit.toml [mcp.*]" };
  }
  const token = await getMcpToken(name);
  if (!token) {
    return {
      name,
      declared,
      status: "missing",
      detail: `run 'kit mcp auth ${name}' to authorize`,
    };
  }
  if (token.expiresAt) {
    const exp = Date.parse(token.expiresAt);
    if (Number.isFinite(exp) && exp < Date.now()) {
      return {
        name,
        declared,
        status: "expired",
        expiresAt: token.expiresAt,
        detail: `expired ${token.expiresAt} — re-authorize`,
      };
    }
  }
  if (declared.scopes && token.scopes) {
    const missing = declared.scopes.filter((s) => !token.scopes!.includes(s));
    if (missing.length > 0) {
      return {
        name,
        declared,
        status: "scope-mismatch",
        scopes: token.scopes,
        detail: `missing scopes: ${missing.join(", ")}`,
      };
    }
  }
  return {
    name,
    declared,
    status: "ok",
    expiresAt: token.expiresAt,
    scopes: token.scopes,
  };
}

export async function statusAll(config: McpConfig | undefined): Promise<McpStatusEntry[]> {
  if (!config) return [];
  const out: McpStatusEntry[] = [];
  for (const [name, declared] of Object.entries(config)) {
    out.push(await statusForMcp(name, declared));
  }
  return out;
}

/**
 * Resolve token for runtime use. Throws when missing/expired so callers
 * surface a clear error instead of making API calls with a bad bearer.
 */
export async function resolveMcpToken(name: string): Promise<string> {
  const token = await getMcpToken(name);
  if (!token) {
    throw new Error(`No MCP token for "${name}". Run 'kit mcp auth ${name}' first.`);
  }
  if (token.expiresAt) {
    const exp = Date.parse(token.expiresAt);
    if (Number.isFinite(exp) && exp < Date.now()) {
      throw new Error(`MCP token for "${name}" expired ${token.expiresAt}. Re-authorize.`);
    }
  }
  return token.accessToken;
}

/**
 * For headless flows (CI), accept a token directly without browser-OAuth.
 * Used by `kit mcp auth <name> --from-env <VAR>` style invocations.
 */
export async function storeStaticToken(
  name: string,
  accessToken: string,
  opts: { scopes?: string[]; subject?: string; ttlSeconds?: number } = {},
): Promise<void> {
  const expiresAt = opts.ttlSeconds
    ? new Date(Date.now() + opts.ttlSeconds * 1000).toISOString()
    : undefined;
  await setMcpToken(name, {
    accessToken,
    scopes: opts.scopes,
    subject: opts.subject,
    expiresAt,
  });
}

/**
 * Test-only: delete the token store so tests start fresh.
 */
export async function _resetTokenStoreForTests(): Promise<void> {
  try {
    await access(TOKEN_FILE);
    await writeFile(TOKEN_FILE, "{}\n", "utf-8");
  } catch {
    /* nothing to reset */
  }
}
