/**
 * kit control plane (Pillar 2) — offline-verifiable signed approval tokens (§4.5, approval-routing).
 *
 * `requestApproval` can already prompt interactively or call a webhook/remote API. This adds a
 * THIRD, offline, no-egress path: an org authority mints a time-boxed, operation-scoped **signed
 * approval token**; a machine honors a valid one BEFORE prompting, with interactive fallback when
 * no token grants. This lets an org "route" approvals as signed artifacts (committed / distributed
 * via the same pull channel) instead of a live service — verified offline against the same
 * `.kit-policy.signers` trust anchor as policy and revocations.
 *
 * Safe by construction (mirrors the revocation trust model):
 *   - **Fail-closed authority:** a token grants only if it is signed by an ORG trust-anchor signer
 *     (the approval authority), the signature verifies, the token matches the exact operation +
 *     environment, it has not expired, and the signer is not revoked. Anything else → no grant
 *     (falls through to the existing interactive/remote path — never auto-approves).
 *   - **No root-trust-from-the-network:** authority is the LOCAL anchor; no anchor ⇒ no grant.
 *   - **Time-boxed:** a token authorizes op+env only until `expires` (documented replay window).
 *   - Local file, offline, no telemetry.
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  identityId,
  signWithIdentity,
  tryLoadIdentity,
  localPublicKeys,
  isRevokedWith,
  verifySignature,
} from "./identity.js";
import { policySignersMap, getSignersPath } from "./policy-trust.js";

/** Append-only store of signed approval tokens at the project root. */
export const APPROVAL_TOKENS_FILE = ".kit-approvals.jsonl";

export interface ApprovalToken {
  operation: string;
  environment: string;
  /** The approver identity id (must be an org trust-anchor signer to be honored). */
  kid: string;
  /** ISO timestamp the token was minted. */
  ts: string;
  /** ISO timestamp after which the token no longer grants. */
  expires: string;
  /** base64 Ed25519 signature over `approvalStatement(...)`. */
  sig: string;
}

/** Canonical bytes signed for an approval token — stable across machines for offline verify. */
export function approvalStatement(
  operation: string,
  environment: string,
  ts: string,
  expires: string,
): string {
  return `kit-approve\nop=${operation}\nenv=${environment}\nts=${ts}\nexp=${expires}`;
}

function tokensPath(root: string): string {
  return join(root, APPROVAL_TOKENS_FILE);
}

/** A key that can sign an approval: the resolved keystore, so a hardware backend signs it. */
export interface ApprovalSigner {
  publicKeyPem(): string | null;
  sign(data: Buffer | string): Buffer;
}

/**
 * Can a person answer here? An approval stands for a person, so it is minted only on a terminal
 * (stdin and stdout) that is not in a declared non-interactive mode. An agent's tool call, CI and
 * piped input all fail this. It is a gate on the obvious path, not proof: a process running as
 * the same user can read a file-backed key and sign without kit. Only a hardware key that needs
 * a touch proves presence; `require_hardware_identity` makes approvals demand one.
 */
export function personCanAnswer(t: {
  stdinTTY: boolean;
  stdoutTTY: boolean;
  nonInteractive: boolean;
}): boolean {
  return t.stdinTTY && t.stdoutTTY && !t.nonInteractive;
}

/**
 * Mint a signed approval token for `operation`+`environment`, valid for `ttlSeconds`, and append it
 * to `<root>/.kit-approvals.jsonl`. Signed by `opts.signer` when given (the CLI passes the resolved
 * keystore), else by the CURRENT file identity. The verifier only honors it if that identity is in
 * the org trust anchor. Throws if there is no identity to sign with.
 */
export function mintApprovalToken(
  operation: string,
  environment: string,
  ttlSeconds: number,
  opts: { root?: string; dir?: string; now?: Date; signer?: ApprovalSigner } = {},
): ApprovalToken {
  const root = opts.root ?? process.cwd();
  const signerPub = opts.signer?.publicKeyPem();
  const kid = opts.signer ? signerPub && identityId(signerPub) : tryLoadIdentity(opts.dir)?.id;
  if (!kid) throw new Error("no current identity to sign the approval token");
  const now = opts.now ?? new Date();
  const ts = now.toISOString();
  const expires = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const statement = approvalStatement(operation, environment, ts, expires);
  const sig = (
    opts.signer ? opts.signer.sign(statement) : signWithIdentity(statement, opts.dir)
  ).toString("base64");
  const token: ApprovalToken = { operation, environment, kid, ts, expires, sig };
  const path = tokensPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(token) + "\n", { encoding: "utf-8", mode: 0o600 });
  return token;
}

export interface ApprovalCheck {
  approved: boolean;
  detail: string;
}

/** Parse the token store; skip malformed lines (fail-closed, never throw). */
function loadTokens(root: string): ApprovalToken[] {
  const path = tokensPath(root);
  if (!existsSync(path)) return [];
  const out: ApprovalToken[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ApprovalToken);
    } catch {
      /* skip a malformed token line */
    }
  }
  return out;
}

/**
 * Is there a valid signed approval token granting `operation`+`environment`? Fail-closed: requires
 * a local trust anchor, an org-authority signer, a verifying signature, an unexpired token, and a
 * non-revoked signer. Returns the grant + a human detail (never throws).
 */
export function checkSignedApproval(
  request: { operation: string; environment: string },
  root: string,
  opts: { dir?: string; now?: Date } = {},
): ApprovalCheck {
  const tokens = loadTokens(root);
  if (tokens.length === 0) return { approved: false, detail: "no approval tokens" };
  // Authority comes from the LOCAL anchor; without it we cannot trust any token.
  if (!existsSync(getSignersPath(root))) {
    return { approved: false, detail: "no local .kit-policy.signers trust anchor" };
  }
  const orgSigners = policySignersMap(root);
  const trustedKeys = new Map<string, string>([...localPublicKeys(opts.dir), ...orgSigners]);
  const authorities = new Set<string>(orgSigners.keys());
  const nowMs = (opts.now ?? new Date()).getTime();

  for (const tk of tokens) {
    if (tk.operation !== request.operation || tk.environment !== request.environment) continue;
    if (!authorities.has(tk.kid)) continue; // approver is not an org authority
    const expMs = Date.parse(tk.expires);
    if (!Number.isFinite(expMs) || expMs <= nowMs) continue; // expired / unparseable
    const pub = trustedKeys.get(tk.kid);
    if (!pub) continue;
    const ok = verifySignature(
      approvalStatement(tk.operation, tk.environment, tk.ts, tk.expires),
      Buffer.from(tk.sig, "base64"),
      pub,
    );
    if (!ok) continue; // forged / tampered
    if (isRevokedWith(tk.kid, trustedKeys, authorities, opts.dir)) continue; // revoked approver
    return { approved: true, detail: `signed by ${tk.kid}, expires ${tk.expires}` };
  }
  return { approved: false, detail: "no valid approval token for this operation" };
}
