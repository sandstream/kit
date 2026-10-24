/**
 * `kit secrets rotate <KEY> --via supabase-mgmt-api --mode signing-key-rotate | signing-key-cutover`
 *
 * Supabase's successor to the JWT-secret roll. `--mode jwt-secret-roll` calls an endpoint the
 * published Management API no longer lists; signing keys are what Supabase documents now.
 *
 * Rotating is reversible: a new key signs new tokens and the old one moves to `previously_used`,
 * where it still verifies the tokens it signed. That is the wrong end state after a LEAK of the old
 * key, because whoever holds it can still mint tokens that verify. `signing-key-cutover` therefore
 * also revokes the keys the rotation demoted: tokens they signed stop verifying. That half is
 * irreversible, so it takes its own one-shot elevation and its own policy op, like the JWT cutover.
 * It is a mode rather than a flag on purpose: the mode is what names the elevation scope.
 *
 * Nothing is written to the vault afterwards. Signing keys are asymmetric by default (ES256):
 * Supabase keeps the private half and verifiers read the project's public JWKS, so there is no
 * new secret value to store.
 */

import { c } from "./utils/colors.js";
import { scopeFor } from "./elevation-scopes.js";
import type { SigningKey, SigningKeyRotation } from "sandstream-kit-plugin-supabase";

export type SupabaseRotateMode =
  | "scoped-key-mint"
  | "jwt-secret-roll"
  | "signing-key-rotate"
  | "signing-key-cutover";

const MODES: readonly SupabaseRotateMode[] = [
  "scoped-key-mint",
  "jwt-secret-roll",
  "signing-key-rotate",
  "signing-key-cutover",
];

/**
 * Reads `--mode`. `undefined` = not given (the caller auto-detects); `"invalid"` = given but not a
 * mode kit knows, after the error has been printed.
 */
export function parseSupabaseMode(
  raw: string | undefined,
  err: (line: string) => void = console.error,
): SupabaseRotateMode | "invalid" | undefined {
  if (raw === undefined) return undefined;
  if ((MODES as readonly string[]).includes(raw)) return raw as SupabaseRotateMode;
  err(`${c.red}Invalid --mode "${raw}" — use ${MODES.map((m) => `"${m}"`).join(", ")}.${c.reset}`);
  return "invalid";
}

/**
 * What `jwt-secret-roll` users are pointed to. The roll calls an endpoint Supabase's published
 * Management API no longer lists; signing keys are the documented successor.
 */
export const JWT_ROLL_LEGACY_NOTICE =
  "jwt-secret-roll is legacy: Supabase's published Management API no longer lists its endpoint. " +
  "Prefer --mode signing-key-cutover (rotates the JWT signing key and revokes the old one).";

/** Why a cutover refuses a project with no signing key in use. */
export const CUTOVER_NOTHING_TO_REVOKE =
  "signing-key-cutover refused: the project has no signing key in use, so nothing would be revoked " +
  "and tokens signed with its legacy JWT secret would stay valid. Migrate the JWT secret to signing " +
  "keys in the Supabase dashboard first, or use the legacy --mode jwt-secret-roll.";

/** The two modes this module handles; the rest stay in `secrets-rotate-cli.ts`. */
export function isSigningKeyMode(
  mode: SupabaseRotateMode | "invalid" | undefined,
): mode is "signing-key-rotate" | "signing-key-cutover" {
  return mode === "signing-key-rotate" || mode === "signing-key-cutover";
}

/** What the flow needs from outside; injected so the orchestration is testable without a network. */
export interface SigningKeyRotationDeps {
  listSigningKeys: () => Promise<SigningKey[]>;
  rotateSigningKey: () => Promise<SigningKeyRotation>;
  revokeSigningKey: (keyId: string) => Promise<SigningKey>;
  /** Elevation for `scope`; one-shot scopes are consumed. */
  elevate: (scope: string, oneShot: boolean) => Promise<{ ok: boolean; reason: string }>;
  /** `[policy.agent_writes]` refusal reason for a supabase op, or undefined when allowed. */
  policyRefusal: (op: string) => Promise<string | undefined>;
  /** Interactive confirmation; `undefined` when the run is non-interactive. */
  confirm?: (question: string, timeoutMs: number, defaultYes: boolean) => Promise<boolean>;
  log?: (line: string) => void;
  err?: (line: string) => void;
}

export interface SigningKeyRotationOptions {
  revokePrevious: boolean;
  dryRun: boolean;
}

/** The elevation the run needs: the reversible rotate, or the irreversible rotate-and-revoke. */
export function signingKeyScope(revokePrevious: boolean) {
  return scopeFor("rotate", revokePrevious ? "signing-key-cutover" : "signing-key-rotate");
}

/** The policy ops the run performs, in order. Each is checked before any vendor call. */
export function signingKeyPolicyOps(revokePrevious: boolean): string[] {
  return revokePrevious ? ["signing_key_rotate", "signing_key_revoke"] : ["signing_key_rotate"];
}

function describe(k: SigningKey): string {
  return `${k.id} (${k.algorithm}, ${k.status})`;
}

/**
 * Gate checks: policy first (a refusal is the operator's standing decision, so it needs no
 * elevation to report), then elevation, then the confirmation prompt.
 */
async function authorize(
  deps: SigningKeyRotationDeps,
  opts: SigningKeyRotationOptions,
  err: (line: string) => void,
): Promise<boolean> {
  for (const op of signingKeyPolicyOps(opts.revokePrevious)) {
    const refusal = await deps.policyRefusal(op);
    if (refusal) {
      err(`${c.red}✗ refused by [policy.agent_writes]: ${refusal}${c.reset}`);
      return false;
    }
  }
  const { scope, oneShot } = signingKeyScope(opts.revokePrevious);
  const elev = await deps.elevate(scope, oneShot);
  if (!elev.ok) {
    err(`${c.red}✗ ${elev.reason}${c.reset}`);
    return false;
  }
  if (!deps.confirm) return true;
  // The reversible rotate auto-confirms on walk-away; the revoke promises auto-no and fails closed.
  const ok = opts.revokePrevious
    ? await deps.confirm(
        `Rotate AND revoke the previous signing key(s)? [y/N, auto-no in 15s]: `,
        15_000,
        false,
      )
    : await deps.confirm(`Rotate the JWT signing key? [Y/n, auto-yes in 10s]: `, 10_000, true);
  if (!ok) err(`${c.dim}Aborted.${c.reset}`);
  return ok;
}

export async function runSigningKeyRotation(
  deps: SigningKeyRotationDeps,
  opts: SigningKeyRotationOptions,
): Promise<boolean> {
  const log = deps.log ?? console.log;
  const err = deps.err ?? console.error;

  const before = await deps.listSigningKeys();
  const inUse = before.filter((k) => k.status === "in_use");
  log(
    `${c.dim}Signing keys: ${before.length}, in use: ${inUse.map(describe).join(", ") || "none"}${c.reset}`,
  );
  log(
    opts.revokePrevious
      ? `${c.yellow}⚠ signing-key-cutover: every token the current key signed stops verifying (sessions end).${c.reset}`
      : `${c.dim}The current key moves to previously_used and keeps verifying the tokens it signed.${c.reset}`,
  );
  if (opts.revokePrevious && inUse.length === 0) {
    // Nothing would be demoted, so nothing revoked: the cutover would leave every leaked token valid.
    err(`${c.red}✗ ${CUTOVER_NOTHING_TO_REVOKE}${c.reset}`);
    return false;
  }
  if (opts.dryRun) {
    log(`${c.dim}--dry-run: not rotating. Remove flag to proceed.${c.reset}`);
    return true;
  }
  if (!(await authorize(deps, opts, err))) return false;

  const rotation = await deps.rotateSigningKey();
  log(`  ${c.green}✓${c.reset} new signing key in use: ${describe(rotation.activated)}`);
  for (const k of rotation.demoted) log(`  ${c.green}✓${c.reset} demoted: ${describe(k)}`);

  if (!opts.revokePrevious) {
    if (rotation.demoted.length > 0)
      log(
        `${c.dim}If the previous key leaked, it can still sign tokens that verify. Revoke it in the dashboard, or use --mode signing-key-cutover.${c.reset}`,
      );
    log(
      `${c.dim}No secret to store: Supabase keeps the private key; verifiers use the project's JWKS.${c.reset}`,
    );
    return true;
  }

  // Revoke one at a time and report each, so a failure part-way leaves an exact record.
  for (const k of rotation.demoted) {
    try {
      const revoked = await deps.revokeSigningKey(k.id);
      log(`  ${c.green}✓${c.reset} revoked: ${describe(revoked)}`);
    } catch (e: unknown) {
      err(
        `${c.red}✗ revoke ${k.id} failed: ${e instanceof Error ? e.message : String(e)}${c.reset}`,
      );
      err(`${c.dim}The new key is in use; ${k.id} still verifies until revoked.${c.reset}`);
      return false;
    }
  }
  log(
    `${c.dim}No secret to store: Supabase keeps the private key; verifiers use the project's JWKS.${c.reset}`,
  );
  return true;
}

/** CLI wiring: real plugin, elevation, policy and prompt behind the injected interface. */
export async function cmdRotateSupabaseSigningKey(
  projectRef: string,
  mode: "signing-key-rotate" | "signing-key-cutover",
  args: string[],
): Promise<boolean> {
  const supabase = await import("sandstream-kit-plugin-supabase").catch(() => null);
  if (!supabase) {
    console.error(`${c.red}sandstream-kit-plugin-supabase not installed.${c.reset}`);
    return false;
  }
  const { loadConfig } = await import("./config.js");
  const { resolveConfigPath } = await import("./cli-shared.js");
  const { enforcePolicy } = await import("./policy-gate.js");
  const { requireElevation, consumeElevation } = await import("./elevation.js");
  const { isNonInteractive } = await import("./environment.js");
  const { promptConfirm } = await import("./utils/prompt.js");

  let client: ReturnType<typeof supabase.makeClient>;
  try {
    client = supabase.makeClient();
  } catch (e: unknown) {
    console.error(`${c.red}✗ ${e instanceof Error ? e.message : String(e)}${c.reset}`);
    return false;
  }
  const policy = (await loadConfig(resolveConfigPath()).catch(() => null))?.policy;
  try {
    return await runSigningKeyRotation(
      {
        listSigningKeys: () => supabase.listSigningKeys(client, projectRef),
        rotateSigningKey: () => supabase.rotateSigningKey(client, projectRef),
        revokeSigningKey: (id) => supabase.revokeSigningKey(client, projectRef, id),
        elevate: (scope, oneShot) => (oneShot ? consumeElevation(scope) : requireElevation(scope)),
        policyRefusal: async (op) => (await enforcePolicy(policy, "supabase", op))?.reason,
        confirm: isNonInteractive() ? undefined : promptConfirm,
      },
      { revokePrevious: mode === "signing-key-cutover", dryRun: args.includes("--dry-run") },
    );
  } catch (e: unknown) {
    console.error(
      `${c.red}✗ Supabase Management API: ${e instanceof Error ? e.message : String(e)}${c.reset}`,
    );
    return false;
  }
}
