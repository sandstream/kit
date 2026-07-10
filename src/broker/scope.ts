/**
 * kit exec-broker — the pure scope-decision core (Pillar 3, 5.0-rc).
 *
 * Design: `kit-research/docs/research/pillar3-exec-broker-5.0.md` §3.1.
 *
 * Three deterministic, zero-LLM predicates that answer "is this action inside the agent's
 * SCOPE?" against a `ProfileScope` (the signed RoE from Pillar 4). No I/O — the caller supplies
 * the already-resolved inputs; the enforcement points (PreToolUse hooks, `withGovernance`) sit
 * ABOVE this and feed it the scope via `verifiedScope()` (fail-closed: a null scope never
 * reaches here). Pure ⇒ fully unit-testable and safe to diff in CI.
 *
 * Fail-closed field semantics (within a valid scope):
 *   - egress: undefined/empty ⇒ NO host allowed (network must be declared explicitly);
 *   - fs: undefined/empty ⇒ default to the project root ".";
 *   - secrets: undefined/empty ⇒ NO secret exposed (secret-scoped by default).
 */
import { resolve, relative, isAbsolute } from "node:path";
import type { ProfileScope } from "../profile/schema.js";

/**
 * True when `host` is loopback / link-local / an RFC1918 private address. Such hosts are denied
 * by SUBDOMAIN matching (they may only be reached if listed VERBATIM in the egress allowlist),
 * so a broad `example.com` entry can never be tricked into permitting an internal target.
 */
export function isLoopbackOrPrivate(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "0.0.0.0" || h === "::1" || h === "[::1]") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true; // link-local
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true; // 172.16.0.0 – 172.31.255.255
  return false;
}

/**
 * Is `host` reachable under this scope's egress allowlist? An exact allowlist entry always wins
 * (even a deliberately-listed internal host). Otherwise a host matches an entry when it equals it
 * or is a subdomain of it (`api.acme.com` matches entry `acme.com`) — but loopback/private hosts
 * are never subdomain-matched. Undefined/empty egress ⇒ nothing is reachable.
 */
export function hostInScope(host: string, scope: ProfileScope): boolean {
  const egress = scope.egress ?? [];
  const h = host.toLowerCase().replace(/\.$/, ""); // drop a trailing FQDN dot
  const entries = egress.map((e) => e.toLowerCase().replace(/\.$/, ""));
  if (entries.includes(h)) return true;
  if (isLoopbackOrPrivate(h)) return false;
  return entries.some((e) => e.length > 0 && h.endsWith(`.${e}`));
}

/**
 * Is a write to `targetPath` inside this scope's filesystem write-scope? Paths are resolved
 * against `root` and compared with a traversal-safe containment check (a `..` escape lands
 * outside and is denied). Undefined/empty `fs` defaults to the project root ".".
 */
export function pathInScope(targetPath: string, scope: ProfileScope, root: string): boolean {
  const base = resolve(root);
  const target = isAbsolute(targetPath) ? resolve(targetPath) : resolve(base, targetPath);
  const fsScopes = scope.fs && scope.fs.length > 0 ? scope.fs : ["."];
  return fsScopes.some((entry) => {
    const allowed = isAbsolute(entry) ? resolve(entry) : resolve(base, entry);
    if (target === allowed) return true;
    const rel = relative(allowed, target);
    // Inside `allowed` iff the relative path doesn't climb out (no leading "..") and isn't absolute.
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}

/**
 * Is the secret `key` allowed to be exposed for an operation under this scope? Secret-scoped by
 * default: only keys listed in `scope.secrets` are permitted; undefined/empty ⇒ none.
 */
export function secretInScope(key: string, scope: ProfileScope): boolean {
  return (scope.secrets ?? []).includes(key);
}
