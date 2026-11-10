/**
 * Elevation gate for destructive secret operations.
 *
 * User requirement: agents (or unauthorized humans) must not be able to
 * rotate / migrate / propagate / register-fake a key without an explicit
 * human-loop confirmation. This module provides:
 *
 *   1. A short-lived elevation marker (`.kit/elevation.json`) with TTL,
 *      created by `kit auth elevate`.
 *   2. Optional TOTP (RFC 6238) verification when `KIT_TOTP_SECRET` is set.
 *      Without TOTP, falls back to a plain interactive "YES" prompt.
 *   3. A `requireElevation()` check that destructive ops call before running.
 *      In non-interactive / agent contexts: fails closed unless
 *      `KIT_ELEVATED=1` is set (CI escape hatch. gets audit-logged loudly
 *      so a leaked CI env doesn't silently bypass).
 */

import { readFile, writeFile, mkdir, access, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendAuditEventDirect } from "./audit.js";
import { secureFile } from "./utils/secure-perms.js";

// Preserve the public API while encoding and enrollment have separate modules.
export { enrollTotp, resolveTotpSecret, type EnrolledSecret } from "./elevation-enrollment.js";
export {
  buildOtpAuthUri,
  generateBase32Secret,
  generateTotp,
  verifyTotp,
  type OtpAuthUriInput,
} from "./elevation-totp.js";

const ELEVATION_FILE = ".kit/elevation.json";
const DEFAULT_TTL_MINUTES = 15;

// (Removed dead `ONE_SHOT_SCOPES` / `isOneShotScope`: never called in
// production, and its scope strings had drifted from the real ones. The
// authoritative one-shot decision lives in elevation-scopes.ts →
// `scopeFor(...).oneShot`.)

/**
 * Loud one-time stderr warning for the CI escape hatch. Emitted once per
 * process so a single `kit secrets rotate ... ` invocation doesn't spam,
 * but the operator sees it on stderr even when stdout is captured.
 */
let warnedAboutCiBypass = false;
function warnCiBypassOnce(operation: string): void {
  if (warnedAboutCiBypass) return;
  warnedAboutCiBypass = true;
  console.error(
    `[kit] WARNING: KIT_ELEVATED=1 is bypassing the TTY elevation gate for "${operation}". This is logged to .kit-audit.jsonl.`,
  );
}

/**
 * Records each granted or refused elevation decision in the local audit log. Returns true on success; false means the audit-log itself
 * couldn't be written, which the caller treats as a refusal-to-elevate.
 *
 * Audit-log write must succeed before destructive ops proceed. The
 * "always-allow if audit-log down" pattern is exactly the silent-bypass
 * we're closing.
 */
async function auditElevationDecision(
  operation: string,
  granted: boolean,
  reason: string,
  method: ElevationState["method"] | "ci-env" | "none",
  cwd: string,
): Promise<boolean> {
  return appendAuditEventDirect(
    {
      operation: "elevation-check",
      environment: process.env.KIT_ENV ?? process.env.NODE_ENV ?? "unknown",
      success: granted,
      metadata: {
        requested_scope: operation,
        method,
        reason,
        granter: process.env.USER ?? "unknown",
      },
    },
    { cwd },
  );
}

export interface ElevationState {
  expiresAt: string; // ISO
  scope: string; // free-form: "rotate"|"migrate"|"all"|...
  granter: string; // user / agent identifier
  method: "yes-prompt" | "totp" | "ci-env";
}

interface BoundElevationState extends ElevationState {
  projectDirectory: string;
  grantId: string;
}

interface VerifiedElevationState extends BoundElevationState {
  sig: string;
}

// ── Marker signing ───────────────────────────────────────────────────────────
//
// The elevation marker lives in the PROJECT dir (.kit/elevation.json). Without
// a signature, any process that can write that file could forge elevation and
// bypass the TOTP/human gate entirely. We HMAC-sign the marker with a key kept
// OUTSIDE the project, in ~/.kit/elevation.key (0600). A process sandboxed to
// the project (the agent threat model) can write the marker but cannot read the
// key, so it cannot produce a valid signature.

function elevationKeyPath(): string {
  return join(homedir(), ".kit", "elevation.key");
}

function isFileError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

class IncompleteElevationKeyError extends Error {}

/** Read exactly 32 encoded key bytes. Never create or repair a key during verification. */
async function readElevationSigningKey(): Promise<Buffer> {
  const hex = (await readFile(elevationKeyPath(), "utf-8")).trim();
  if (/^[a-f0-9]{0,63}$/i.test(hex)) {
    throw new IncompleteElevationKeyError("Elevation signing key is incomplete");
  }
  if (!/^[a-f0-9]{64}$/i.test(hex)) {
    throw new Error("Invalid elevation signing key: expected exactly 32 hexadecimal bytes");
  }
  return Buffer.from(hex, "hex");
}

/** Grant writes can wait briefly for an exclusive creator to complete its key. */
async function readSigningKeyForWrite(): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readElevationSigningKey();
    } catch (error) {
      if (!(error instanceof IncompleteElevationKeyError) || attempt === 4) throw error;
      await new Promise((done) => setTimeout(done, 15 * (attempt + 1)));
    }
  }
}

/** Machine-local HMAC key, created once (0600). Create is atomic (flag "wx"):
 *  on a lost create race the winner's key is re-read, so all callers agree. */
async function getElevationSigningKey(): Promise<Buffer> {
  const keyPath = elevationKeyPath();
  try {
    return await readSigningKeyForWrite();
  } catch (error) {
    if (!isFileError(error, "ENOENT")) throw error;
  }
  const key = randomBytes(32);
  await mkdir(dirname(keyPath), { recursive: true });
  try {
    await writeFile(keyPath, key.toString("hex") + "\n", {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    secureFile(keyPath); // owner-only on Windows (NTFS ignores mode). #43
    return key;
  } catch (error) {
    if (!isFileError(error, "EEXIST")) throw error;
    return readSigningKeyForWrite();
  }
}

/** The canonical signed form has a stable field order and excludes the signature. */
function elevationPayload(state: BoundElevationState): string {
  return JSON.stringify({
    expiresAt: state.expiresAt,
    scope: state.scope,
    granter: state.granter,
    method: state.method,
    projectDirectory: state.projectDirectory,
    grantId: state.grantId,
  });
}

async function signElevation(state: BoundElevationState): Promise<string> {
  const key = await getElevationSigningKey();
  return createHmac("sha256", key).update(elevationPayload(state)).digest("hex");
}

async function verifyElevationSig(state: BoundElevationState, sig: string): Promise<boolean> {
  if (typeof sig !== "string" || !/^[a-f0-9]{64}$/i.test(sig)) return false;
  const key = await readElevationSigningKey();
  const expected = createHmac("sha256", key).update(elevationPayload(state)).digest();
  const actual = Buffer.from(sig, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function stateFromMarker(parsed: Partial<VerifiedElevationState>): VerifiedElevationState | null {
  if (
    !parsed.expiresAt ||
    !parsed.scope ||
    typeof parsed.grantId !== "string" ||
    !/^[a-f0-9]{32}$/.test(parsed.grantId)
  )
    return null;
  return {
    expiresAt: parsed.expiresAt,
    scope: parsed.scope,
    granter: parsed.granter ?? "unknown",
    method: parsed.method ?? "yes-prompt",
    projectDirectory: parsed.projectDirectory ?? "",
    grantId: parsed.grantId,
    sig: parsed.sig ?? "",
  };
}

/**
 * Synchronous form of the canonical project path that grants record.
 * Grants record `fs.promises.realpath`, which is the native resolver. On Windows the
 * JavaScript `realpathSync` keeps 8.3 short names (RUNNER~1) that the native resolver
 * expands, so only the native form can equal the recorded binding.
 */
function canonicalProjectSync(cwd: string): string {
  return realpathSync.native(cwd);
}

async function readBoundElevation(cwd: string): Promise<VerifiedElevationState | null> {
  const path = resolve(cwd, ELEVATION_FILE);
  try {
    await access(path);
  } catch {
    return null; // no marker file → not elevated (the normal, expected case)
  }
  // The file exists. Further failure indicates an anomaly (corruption / tampering),
  // not "not elevated". Stay fail-closed (return null) but never SILENTLY: a
  // tampered marker must not look identical to an expired one.
  try {
    const text = await readFile(path, "utf-8");
    const parsed = JSON.parse(text) as Partial<BoundElevationState> & { sig?: string };
    if (parsed.projectDirectory !== (await realpath(cwd))) {
      console.warn(
        "[kit] elevation marker has no matching project binding; fresh confirmation required",
      );
      return null;
    }
    const state = stateFromMarker(parsed);
    if (!state) return null;
    // Reject unsigned, tampered, or forged markers. Only an HMAC signed with the
    // machine-local key is honored. This is what makes the gate unforgeable.
    if (!(await verifyElevationSig(state, state.sig))) {
      console.warn(
        "[kit] elevation marker present but signature invalid. ignoring (tampered/forged?)",
      );
      return null;
    }
    const { elevationGrantIsActive } = await import("./elevation-authority.js");
    if (!elevationGrantIsActive(state.projectDirectory, state.grantId)) return null;
    if (canonicalProjectSync(cwd) !== parsed.projectDirectory) return null;
    return state;
  } catch {
    console.warn("[kit] elevation marker present but unreadable/corrupt. ignoring");
    return null;
  }
}

export async function readElevation(cwd: string = process.cwd()): Promise<ElevationState | null> {
  const state = await readBoundElevation(cwd);
  if (!state) return null;
  return {
    expiresAt: state.expiresAt,
    scope: state.scope,
    granter: state.granter,
    method: state.method,
  };
}

function removeElevationMarker(cwd: string): void {
  rmSync(resolve(cwd, ELEVATION_FILE), { force: true });
}

export async function writeElevation(
  state: ElevationState,
  cwd: string = process.cwd(),
): Promise<void> {
  await assertElevationWriteAllowed("write-elevation", cwd, {
    scope: state.scope,
    method: state.method,
  });
  const path = resolve(cwd, ELEVATION_FILE);
  await mkdir(dirname(path), { recursive: true });
  const boundState = {
    ...state,
    projectDirectory: await realpath(cwd),
    grantId: randomBytes(16).toString("hex"),
  };
  const sig = await signElevation(boundState);
  const { publishElevationGrant } = await import("./elevation-authority.js");
  publishElevationGrant(boundState.projectDirectory, boundState.grantId, () => {
    const temporary = `${path}.${boundState.grantId}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ ...boundState, sig }, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  });
}

export async function clearElevation(cwd: string = process.cwd()): Promise<void> {
  await assertElevationWriteAllowed("clear-elevation", cwd);
  const { revokeElevationGrant } = await import("./elevation-authority.js");
  revokeElevationGrant(await realpath(cwd), () => removeElevationMarker(cwd));
}

async function assertElevationWriteAllowed(
  operation: string,
  cwd: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite(operation, metadata, { cwd });
    throw new Error(refusal.reason);
  }
}

/**
 * Is this marker still within its TTL? The single source of the expiry rule.
 *
 * It exists because the rule had THREE implementations that did not agree at the
 * boundary: `requireElevation` (the enforcer) and `isElevated` both treated
 * `expires < now` as expired, while `kit auth status` computed validity as
 * `expires > now`. At the exact expiry millisecond the gate therefore GRANTED while the
 * status command reported "expired". a one-millisecond window in which kit's own status
 * display contradicted its own gate. An unparseable timestamp is expired everywhere
 * (fail closed).
 */
export function elevationIsActive(
  state: Pick<ElevationState, "expiresAt">,
  now: number = Date.now(),
): boolean {
  const expires = Date.parse(state.expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires >= now;
}

/** Does `scope` authorize `operation`? `all` covers everything; otherwise exact. */
export function elevationCoversScope(scope: string, operation: string): boolean {
  return scope === "all" || scope === operation;
}

/**
 * Returns true if an unexpired elevation marker exists that covers the
 * requested operation scope.
 */
export async function isElevated(operation: string, cwd: string = process.cwd()): Promise<boolean> {
  const state = await readElevation(cwd);
  if (!state) return false;
  if (!elevationIsActive(state)) return false;
  return elevationCoversScope(state.scope, operation);
}

export function elevationTtlMinutes(): number {
  const env = process.env.KIT_ELEVATION_TTL_MINUTES;
  if (env === undefined) return DEFAULT_TTL_MINUTES;
  const minutes = Number(env);
  if (!/^[0-9]+$/.test(env) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 240) {
    throw new Error("KIT_ELEVATION_TTL_MINUTES must be a whole decimal number between 1 and 240");
  }
  return minutes;
}

/**
 * Mints a fresh elevation marker covering `scope` for the configured TTL.
 * Caller is responsible for prompting / verifying the user before calling.
 */
export async function grantElevation(
  scope: string,
  method: ElevationState["method"],
  cwd: string = process.cwd(),
  granter: string = process.env.USER || "unknown",
): Promise<ElevationState> {
  // Read-only mode: refuse before writing the elevation marker. Granting
  // Elevation is a write. Without this gate a read-only session could
  // still mint a marker for a subsequent destructive op.
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("grant-elevation", { scope, method }, { cwd });
    throw new Error(refusal.reason);
  }
  const expiresAt = new Date(Date.now() + elevationTtlMinutes() * 60_000).toISOString();
  const state: ElevationState = { expiresAt, scope, granter, method };
  await writeElevation(state, cwd);
  return state;
}

/**
 * Throws (or returns false in nice mode) when the active context isn't
 * elevated for `operation`. Used by every destructive secrets-* command.
 *
 * Order of resolution:
 *   1. `KIT_ELEVATED=1` env var (CI escape hatch).
 *   2. A live elevation marker covering the operation.
 *   3. Otherwise: not elevated.
 *
 * Every decision. granted or refused. emits an audit-log entry before
 * returning. If the audit-log write itself fails, the call returns
 * `{ ok: false }` even if the credential would otherwise be granted. The
 * intent is: a code path that runs destructive ops must always leave a
 * forensic trail; "audit-log down" is treated identically to "elevation
 * refused" so the silent-bypass property is eliminated.
 */
export async function requireElevation(
  operation: string,
  cwd: string = process.cwd(),
): Promise<{ ok: boolean; reason: string }> {
  const decide = async (
    ok: boolean,
    reason: string,
    method: ElevationState["method"] | "ci-env" | "none",
  ): Promise<{ ok: boolean; reason: string }> => {
    const audited = await auditElevationDecision(operation, ok, reason, method, cwd);
    if (ok && !audited) {
      return {
        ok: false,
        reason: "audit-log unavailable; refusing elevation (fail-closed)",
      };
    }
    return { ok, reason };
  };

  if (process.env.KIT_ELEVATED === "1") {
    warnCiBypassOnce(operation);
    return decide(true, "KIT_ELEVATED=1 (CI escape hatch)", "ci-env");
  }
  const state = await readElevation(cwd);
  if (!state) {
    return decide(
      false,
      `No elevation marker. Run 'kit auth elevate --scope ${operation}' first.`,
      "none",
    );
  }
  if (!elevationIsActive(state)) {
    return decide(false, "Elevation marker expired. Run 'kit auth elevate' again.", state.method);
  }
  // Kept as two separate checks rather than calling isElevated(): the enforcer must
  // distinguish "expired" from "wrong scope" to give a usable reason. Both now read the
  // rule from one place, so the enforcer and the status display cannot drift again.
  if (!elevationCoversScope(state.scope, operation)) {
    return decide(
      false,
      `Elevation covers scope="${state.scope}" but operation requires "${operation}".`,
      state.method,
    );
  }
  return decide(
    true,
    `Elevated by ${state.granter} via ${state.method} until ${state.expiresAt}`,
    state.method,
  );
}

/**
 * One-shot elevation: same gate as `requireElevation`, but the underlying
 * marker is **deleted** immediately on successful use. Used for scopes that
 * must not be reusable within their TTL window (jwt-secret-roll, etc).
 *
 * The KIT_ELEVATED=1 escape hatch reserves each scope once per process.
 * Reservation precedes asynchronous checks, so concurrent calls cannot reuse it.
 * Human grants use machine-local authority and permit fresh approval in the same process.
 */
const consumedInProcess: Set<string> = new Set();

export async function consumeElevation(
  operation: string,
  cwd: string = process.cwd(),
): Promise<{ ok: boolean; reason: string }> {
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    return refuseWrite("consume-elevation", { scope: operation }, { cwd });
  }
  if (process.env.KIT_ELEVATED === "1") {
    if (consumedInProcess.has(operation)) {
      const reason = `Elevation for "${operation}" already consumed in this process. Re-run 'kit auth elevate' for another one-shot op.`;
      await auditElevationDecision(operation, false, reason, "none", cwd);
      return { ok: false, reason };
    }
    consumedInProcess.add(operation);
    return requireElevation(operation, cwd);
  }
  const state = await readBoundElevation(cwd);
  let reason = "Elevation unavailable, expired, or already consumed. Run 'kit auth elevate' again.";
  let granted = false;
  if (state && elevationIsActive(state) && elevationCoversScope(state.scope, operation)) {
    try {
      const { consumeElevationGrant } = await import("./elevation-authority.js");
      granted = consumeElevationGrant(state, () => {
        // Validate the target and exact signed marker again under the authority transaction.
        if (canonicalProjectSync(cwd) !== state.projectDirectory)
          throw new Error("Approval target changed");
        const path = resolve(state.projectDirectory, ELEVATION_FILE);
        const current = JSON.parse(readFileSync(path, "utf8")) as VerifiedElevationState;
        if (current.sig !== state.sig || elevationPayload(current) !== elevationPayload(state)) {
          throw new Error("Approval marker changed");
        }
        removeElevationMarker(state.projectDirectory);
      });
      if (granted) reason = `One-shot elevation granted by ${state.granter} via ${state.method}`;
    } catch {
      reason = "Elevation authority unavailable; refusing one-shot operation";
    }
  }
  const audited = await auditElevationDecision(
    operation,
    granted,
    reason,
    state?.method ?? "none",
    cwd,
  );
  if (granted && !audited)
    return { ok: false, reason: "audit-log unavailable; refusing elevation (fail-closed)" };
  return { ok: granted, reason };
}

/** Test-only reset of process-local CI bypass consumption and its warning. */
export function _resetConsumedElevationForTests(): void {
  consumedInProcess.clear();
  warnedAboutCiBypass = false;
}
