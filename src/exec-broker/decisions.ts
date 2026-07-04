// Pelare 3 — exec-broker: the three pure, fail-closed decision functions.
//
// These gate the CONCRETE effects of an agent's tool-call (network egress,
// filesystem write, environment exposure) at the moment before `run()` touches a
// real resource. They are PURE: no I/O, no env reads, no throws, no clock, no
// randomness — the same inputs always yield the same decision, so they are the
// security-critical core that is exhaustively unit-testable.
//
// Zero LLM, zero network. Uses only node:path (resolve, sep) and node:url (URL).
//
// BOUNDARY (documented, mirrors identity.ts documenting its same-UID boundary):
// checkFsWrite is a pure string/path-resolve check — it cannot follow symlinks.
// A symlink INSIDE projectRoot that points outside would pass this string check
// yet write outside. Closing that requires fs.realpathSync at the actual write
// site (which breaks purity), so it stays out of this function by design.

import { resolve, sep } from "node:path";

export interface BrokerDecision {
  /** True → the effect is permitted by policy. False → denied (fail-closed). */
  ok: boolean;
  reason?: string;
}

/**
 * Extract a normalized (lowercase) hostname from a target string, or null if it
 * cannot be parsed. Accepts full URLs ("https://host/x", "http://u@host:8080")
 * and bare hosts ("api.example.com", "host:8080"). Returns null — never throws —
 * on malformed input ("", "::::"), so the caller fails closed.
 */
function parseHost(target: string): string | null {
  const attempt = (s: string): string | null => {
    try {
      const h = new URL(s).hostname;
      return h.length > 0 ? h.toLowerCase() : null;
    } catch {
      return null;
    }
  };
  // Try as-is (full URL with scheme) first, then as a bare host by prepending a
  // scheme. Parsing via URL and comparing ONLY the normalized .hostname (never
  // the raw string) neutralizes userinfo ("user@host"), ports, paths, and
  // IDN/punycode homographs — the sharp edges of allowlist matching.
  return attempt(target) ?? attempt("https://" + target);
}

/**
 * Egress gate. Permit `target` only if its hostname matches the allowlist.
 * Matching is case-insensitive on the normalized hostname. An allow entry that
 * starts with "." is a SUFFIX (subdomain) match: ".example.com" permits
 * "example.com" and "api.example.com" but NOT "api.example.com.evil.com". Every
 * other entry is an EXACT host match. An empty allowlist denies everything
 * (default-deny). Malformed targets are denied. Never throws.
 */
export function checkEgress(target: string, opts: { allow: string[] }): BrokerDecision {
  const host = parseHost(target);
  if (host === null) {
    return { ok: false, reason: `egress: unparseable target ${JSON.stringify(target)}` };
  }
  for (const raw of opts.allow) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const entry = raw.toLowerCase();
    if (entry.startsWith(".")) {
      // Suffix/subdomain: host is the bare domain (entry sans leading dot) or a
      // subdomain of it.
      const bare = entry.slice(1);
      if (host === bare || host.endsWith(entry)) return { ok: true };
    } else if (host === entry) {
      return { ok: true };
    }
  }
  return { ok: false, reason: `egress: host ${host} not in allowlist` };
}

/**
 * Filesystem-write gate. Resolve both sides (collapsing any ".." traversal) and
 * permit only when the resolved path is `projectRoot` itself or lives strictly
 * under `projectRoot` + path separator. A relative `path` resolves against
 * projectRoot first. Rejects absolute escapes ("/etc/passwd"), traversal
 * ("../x", "root/../../x"), and the prefix-without-separator trick ("/repofoo"
 * vs root "/repo"). Never throws. See the module-level symlink boundary note.
 */
export function checkFsWrite(path: string, projectRoot: string): BrokerDecision {
  try {
    const root = resolve(projectRoot);
    const target = resolve(root, path);
    if (target === root) return { ok: true };
    if (target.startsWith(root + sep)) return { ok: true };
    return { ok: false, reason: `fs-write: ${target} is outside root ${root}` };
  } catch {
    return { ok: false, reason: "fs-write: unresolvable path" };
  }
}

/**
 * Environment scoping. Return a NEW object containing only the declared keys
 * that are actually present (with string values) in `fullEnv`. Undeclared keys
 * are dropped; declared-but-absent (or undefined-valued) keys are omitted. Never
 * mutates `fullEnv`.
 *
 * CALLER CONTRACT: env is only a real boundary if the caller SPAWNS the child
 * with env:{...scopedEnv} instead of letting it inherit process.env. Returning a
 * subset does nothing if the tool reads process.env directly in-process.
 */
export function scopeEnv(
  declaredKeys: string[],
  fullEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of declaredKeys) {
    const v = fullEnv[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
