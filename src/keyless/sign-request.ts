/**
 * kit keyless credentials (Pillar 2 tail) — the identity bridge for "sign, don't store".
 *
 * `http-sig.ts` is the pure RFC 9421 core (no I/O, no identity). This module wires it to kit's
 * primitives: it decides whether an outbound request's host requires signing (from the SIGNED
 * profile `[scope].sign`, verified offline), and mints the `Signature-Input` + `Signature` headers
 * from the agent's Ed25519 identity — so no long-lived bearer token is stored for that host.
 *
 * Fail-CLOSED, never fabricates auth:
 *   - host not marked keyless           → `not-required` (caller uses its normal credential path);
 *   - host marked keyless but the scope is UNVERIFIED (declared-but-unsigned) → `denied` (the sign
 *     list is not trusted; we must NOT silently fall back to a stored bearer);
 *   - host marked keyless + scope verified, but no usable identity (none, or a hardware mandate
 *     refuses the file key), or the identity is revoked → `denied`.
 * Only a host in the VERIFIED sign list with a usable, non-revoked identity yields `signed`.
 *
 * Deterministic given (request, profile, identity, clock). Offline. Zero LLM.
 */
import {
  signWithIdentity,
  tryLoadIdentity,
  isRevoked,
  localPublicKeys,
  verifySignature,
  isRevokedWith,
} from "../identity.js";
import { checkEgress } from "../exec-broker/decisions.js";
import { profileBrokerPolicy } from "../exec-broker/profile-policy.js";
import {
  signRequest,
  verifyRequest,
  DEFAULT_COMPONENTS,
  type SignableRequest,
  type SignatureHeaders,
  type VerifyResult,
} from "./http-sig.js";

/** Default replay window for a minted signature (seconds). */
const DEFAULT_TTL_SECONDS = 300;

/** Does `target` (URL or bare host) match the keyless sign list? Same semantics as egress. */
export function hostRequiresSigning(target: string, signHosts: string[]): boolean {
  if (signHosts.length === 0) return false;
  return checkEgress(target, { allow: signHosts }).ok;
}

export type SignOutcome =
  | { status: "signed"; headers: SignatureHeaders; keyid: string; detail: string }
  | { status: "not-required"; detail: string }
  | { status: "denied"; detail: string };

export interface SignOutboundOptions {
  /** Project root to resolve the profile scope from. Default `process.cwd()`. */
  root?: string;
  /** Identity directory override (mainly for tests). */
  dir?: string;
  /** Clock for `created`/`expires`. Default now. */
  now?: Date;
  /** Signature lifetime in seconds. Default 300. */
  ttlSeconds?: number;
  /** Covered components. Default `@method`, `@authority`, `@path`. */
  components?: string[];
}

/**
 * Decide-and-sign one outbound request. Reads the signed profile scope to learn which hosts are
 * keyless, then mints RFC 9421 headers from the identity (never throws — a signing failure becomes a
 * `denied` outcome).
 */
export async function signOutbound(
  req: SignableRequest,
  opts: SignOutboundOptions = {},
): Promise<SignOutcome> {
  const root = opts.root ?? process.cwd();
  const prof = await profileBrokerPolicy(root);

  // Host not keyless in the VERIFIED scope. Distinguish "declared but unverified" (fail-closed
  // deny) from "never declared" (not our concern — caller uses its normal credential path).
  if (!hostRequiresSigning(req.url, prof.signHosts)) {
    if (hostRequiresSigning(req.url, prof.signHostsDeclared)) {
      return {
        status: "denied",
        detail: `host requires signing but scope is unverified — ${prof.detail}`,
      };
    }
    return { status: "not-required", detail: "host is not marked keyless in the verified scope" };
  }

  const identity = tryLoadIdentity(opts.dir);
  if (!identity) {
    return { status: "denied", detail: "host requires signing but no identity is available" };
  }
  if (isRevoked(identity.id, opts.dir)) {
    return { status: "denied", detail: `identity ${identity.id} is revoked` };
  }

  const now = opts.now ?? new Date();
  const created = Math.floor(now.getTime() / 1000);
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  try {
    const headers = signRequest(
      req,
      {
        keyid: identity.id,
        created,
        expires: created + ttl,
        components: opts.components ?? DEFAULT_COMPONENTS,
      },
      (data) => signWithIdentity(data, opts.dir),
    );
    return {
      status: "signed",
      headers,
      keyid: identity.id,
      detail: `signed by ${identity.id}, expires in ${ttl}s`,
    };
  } catch (err) {
    // e.g. a hardware mandate refuses the same-UID file key, or a missing covered header.
    return {
      status: "denied",
      detail: `cannot sign: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Verify an INBOUND signed request against locally-trusted identities (kit-to-kit). Resolves the
 * signer's public key from the local identity set and rejects a revoked signer. The general case
 * (a third-party server verifying a kit agent) is the server's job with its own trust set; this is
 * the symmetric helper for kit peers and for tests.
 */
export function verifyInbound(
  req: SignableRequest,
  headers: { signatureInput: string; signature: string },
  opts: { dir?: string; now?: Date; required?: string[] } = {},
): VerifyResult {
  const trusted = localPublicKeys(opts.dir);
  const authorities = new Set(trusted.keys());
  const resolvePub = (kid: string): string | undefined => {
    if (isRevokedWith(kid, trusted, authorities, opts.dir)) return undefined;
    return trusted.get(kid);
  };
  const now = opts.now ? Math.floor(opts.now.getTime() / 1000) : undefined;
  return verifyRequest(req, headers, resolvePub, verifySignature, {
    now,
    required: opts.required,
  });
}
