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
 *      `KIT_ELEVATED=1` is set (CI escape hatch — gets audit-logged loudly
 *      so a leaked CI env doesn't silently bypass).
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendAuditEventDirect } from "./audit.js";

const ELEVATION_FILE = ".kit/elevation.json";
const DEFAULT_TTL_MINUTES = 15;

/**
 * Scopes that, when granted, MUST be consumed (atomically deleted) on use.
 * One elevation = one destructive operation. Rotation modes that need a
 * follow-up rollback path (scoped-key-mint) are intentionally absent — they
 * retain the standard 15-min TTL because the rollback re-uses the marker.
 */
const ONE_SHOT_SCOPES: ReadonlySet<string> = new Set([
  "jwt-secret-roll",
  "purge-history",
  "onecli-register",
]);

export function isOneShotScope(scope: string): boolean {
  return ONE_SHOT_SCOPES.has(scope);
}

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
 * Records every elevation decision — granted or refused — to the local
 * audit log. Returns true on success; false means the audit-log itself
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

// ── Marker signing ───────────────────────────────────────────────────────────
//
// The elevation marker lives in the PROJECT dir (.kit/elevation.json). Without
// a signature, any process that can write that file could forge elevation and
// bypass the TOTP/human gate entirely. We HMAC-sign the marker with a key kept
// OUTSIDE the project, in ~/.kit/elevation.key (0600). A process sandboxed to
// the project (the agent threat model) can write the marker but cannot read the
// key, so it cannot produce a valid signature.

const ELEVATION_KEY_REL = ".kit/elevation.key";

function elevationKeyPath(): string {
  return `${_homedir()}/${ELEVATION_KEY_REL}`;
}

/** Machine-local HMAC key, created once (0600). Create is atomic (flag "wx"):
 *  on a lost create race the winner's key is re-read, so all callers agree. */
async function getElevationSigningKey(): Promise<Buffer> {
  const keyPath = elevationKeyPath();
  try {
    const hex = (await readFile(keyPath, "utf-8")).trim();
    if (hex.length >= 64) return Buffer.from(hex, "hex");
  } catch {
    /* fall through to create */
  }
  const key = randomBytes(32);
  await mkdir(dirname(keyPath), { recursive: true });
  try {
    await writeFile(keyPath, key.toString("hex") + "\n", { encoding: "utf-8", mode: 0o600, flag: "wx" });
    return key;
  } catch {
    const hex = (await readFile(keyPath, "utf-8")).trim();
    return Buffer.from(hex, "hex");
  }
}

/** Canonical signed form — stable field order, excludes the signature itself. */
function elevationPayload(state: ElevationState): string {
  return JSON.stringify({
    expiresAt: state.expiresAt,
    scope: state.scope,
    granter: state.granter,
    method: state.method,
  });
}

async function signElevation(state: ElevationState): Promise<string> {
  const key = await getElevationSigningKey();
  return createHmac("sha256", key).update(elevationPayload(state)).digest("hex");
}

async function verifyElevationSig(state: ElevationState, sig: string): Promise<boolean> {
  if (!sig) return false;
  const expected = Buffer.from(await signElevation(state), "hex");
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, "hex");
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function readElevation(
  cwd: string = process.cwd(),
): Promise<ElevationState | null> {
  const path = resolve(cwd, ELEVATION_FILE);
  try {
    await access(path);
    const text = await readFile(path, "utf-8");
    const parsed = JSON.parse(text) as Partial<ElevationState> & { sig?: string };
    if (!parsed.expiresAt || !parsed.scope) return null;
    const state: ElevationState = {
      expiresAt: parsed.expiresAt,
      scope: parsed.scope,
      granter: parsed.granter ?? "unknown",
      method: parsed.method ?? "yes-prompt",
    };
    // Reject unsigned / tampered / forged markers — only an HMAC signed with the
    // machine-local key is honored. This is what makes the gate unforgeable.
    if (!(await verifyElevationSig(state, parsed.sig ?? ""))) return null;
    return state;
  } catch {
    return null;
  }
}

export async function writeElevation(
  state: ElevationState,
  cwd: string = process.cwd(),
): Promise<void> {
  const path = resolve(cwd, ELEVATION_FILE);
  await mkdir(dirname(path), { recursive: true });
  const sig = await signElevation(state);
  await writeFile(path, JSON.stringify({ ...state, sig }, null, 2) + "\n", "utf-8");
}

export async function clearElevation(
  cwd: string = process.cwd(),
): Promise<void> {
  const path = resolve(cwd, ELEVATION_FILE);
  try {
    const { rm } = await import("node:fs/promises");
    await rm(path);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Returns true if an unexpired elevation marker exists that covers the
 * requested operation scope.
 */
export async function isElevated(
  operation: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  const state = await readElevation(cwd);
  if (!state) return false;
  const expires = Date.parse(state.expiresAt);
  if (!Number.isFinite(expires) || expires < Date.now()) {
    return false;
  }
  return state.scope === "all" || state.scope === operation;
}

export function elevationTtlMinutes(): number {
  const env = process.env.KIT_ELEVATION_TTL_MINUTES;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n > 0 && n <= 240) return n;
  }
  return DEFAULT_TTL_MINUTES;
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
  // elevation IS a write — without this gate a read-only session could
  // still mint a marker for a subsequent destructive op.
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("grant-elevation", { scope, method });
    throw new Error(refusal.reason);
  }
  const expiresAt = new Date(Date.now() + elevationTtlMinutes() * 60_000).toISOString();
  const state: ElevationState = { expiresAt, scope, granter, method };
  await writeElevation(state, cwd);
  return state;
}

// ── TOTP enrollment ─────────────────────────────────────────────────────────
//
// `kit auth setup-totp` generates a fresh base32 secret, writes it to
// ~/.kit/totp-secret (chmod 0o600 so other users can't read it), and
// prints the otpauth provisioning URI for the user's authenticator app.
// The secret only ever exists on disk in that one file; the elevation
// flow reads it via `KIT_TOTP_SECRET` env var (or the new helper that
// reads the file when the env var is unset).

import { homedir as _homedir } from "node:os";

const TOTP_FILE_REL = ".kit/totp-secret";

function totpFilePath(): string {
  return `${_homedir()}/${TOTP_FILE_REL}`;
}

export function generateBase32Secret(byteLength: number = 20): string {
  // ESM-friendly — reuse the top-level import.
  const bytes = randomBytes(byteLength);
  // RFC 4648 base32 (no padding) — same alphabet TOTP libs expect.
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

export interface OtpAuthUriInput {
  /** Identifier shown in the authenticator app (typically user@host). */
  accountName: string;
  /** Top-level label of the entry — appears as section heading. */
  issuer?: string;
  /** Base32 secret. */
  secret: string;
}

export function buildOtpAuthUri(input: OtpAuthUriInput): string {
  const issuer = input.issuer ?? "kit";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.accountName)}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export interface EnrolledSecret {
  secret: string;
  filePath: string;
  uri: string;
  currentCode: string;
}

export async function enrollTotp(opts: {
  accountName: string;
  issuer?: string;
  overwrite?: boolean;
}): Promise<EnrolledSecret> {
  const { writeFile, mkdir, access } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const filePath = totpFilePath();

  // Guard against silently overwriting an existing enrollment — that
  // would invalidate the user's already-registered authenticator entry.
  let exists = false;
  try {
    await access(filePath);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists && !opts.overwrite) {
    throw new Error(
      `TOTP secret already enrolled at ${filePath}. Pass overwrite=true to replace it (your old authenticator entry will stop working).`,
    );
  }

  const secret = generateBase32Secret(20);
  const uri = buildOtpAuthUri({
    accountName: opts.accountName,
    issuer: opts.issuer,
    secret,
  });

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, secret + "\n", { encoding: "utf-8", mode: 0o600 });

  return {
    secret,
    filePath,
    uri,
    currentCode: generateTotp(secret),
  };
}

/**
 * Resolves the TOTP secret in priority order:
 *   1. `KIT_TOTP_SECRET` env var (overrides everything; useful for CI)
 *   2. `~/.kit/totp-secret` file (created by `kit auth setup-totp`)
 *   3. undefined — caller falls back to yes-prompt
 */
export async function resolveTotpSecret(): Promise<string | undefined> {
  if (process.env.KIT_TOTP_SECRET) return process.env.KIT_TOTP_SECRET;
  try {
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(totpFilePath(), "utf-8");
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ── TOTP (RFC 6238) ─────────────────────────────────────────────────────────
//
// Minimal implementation so we don't add an npm dep for a 30-line algorithm.
// Accepts base32-encoded secret in `KIT_TOTP_SECRET`. 6-digit codes,
// 30-second period, SHA-1 — matches Google Authenticator / 1Password / Authy.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = "";
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 char: ${ch}`);
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTotp(
  secretBase32: string,
  step: number = Math.floor(Date.now() / 1000 / 30),
): string {
  const secret = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  // Big-endian uint64. step fits in uint32 for the next ~136 years, so write
  // the high word as zero.
  counter.writeUInt32BE(0, 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 1_000_000).toString().padStart(6, "0");
}

/**
 * Verifies a user-supplied TOTP. Accepts the current step ± 1 (handles minor
 * clock skew, ±30s window). Uses timingSafeEqual for the digit comparison —
 * both sides are fixed 6-ASCII-digit strings, so lengths always match.
 */
export function verifyTotp(
  code: string,
  secretBase32: string,
  windowSteps: number = 1,
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const codeBuf = Buffer.from(code, "ascii");
  const now = Math.floor(Date.now() / 1000 / 30);
  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const expected = Buffer.from(generateTotp(secretBase32, now + delta), "ascii");
    if (expected.length === codeBuf.length && timingSafeEqual(expected, codeBuf)) return true;
  }
  return false;
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
 * Every decision — granted or refused — emits an audit-log entry before
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
    return decide(
      true,
      "KIT_ELEVATED=1 (CI escape hatch)",
      "ci-env",
    );
  }
  const state = await readElevation(cwd);
  if (!state) {
    return decide(
      false,
      `No elevation marker. Run 'kit auth elevate --scope ${operation}' first.`,
      "none",
    );
  }
  const expires = Date.parse(state.expiresAt);
  if (!Number.isFinite(expires) || expires < Date.now()) {
    return decide(
      false,
      "Elevation marker expired. Run 'kit auth elevate' again.",
      state.method,
    );
  }
  if (state.scope !== "all" && state.scope !== operation) {
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
 * The KIT_ELEVATED=1 escape hatch is allowed once per process — after
 * the first consume call the module-scoped `consumedInProcess` flag prevents
 * the same env var from re-grant the same scope on a subsequent call in the
 * same invocation. This matches the "one auth, one destructive op" intent.
 */
const consumedInProcess: Set<string> = new Set();

export async function consumeElevation(
  operation: string,
  cwd: string = process.cwd(),
): Promise<{ ok: boolean; reason: string }> {
  if (consumedInProcess.has(operation)) {
    const reason = `Elevation for "${operation}" already consumed in this process. Re-run 'kit auth elevate' for another one-shot op.`;
    await auditElevationDecision(operation, false, reason, "none", cwd);
    return { ok: false, reason };
  }
  const result = await requireElevation(operation, cwd);
  if (!result.ok) return result;

  // Atomic cross-process claim: rename the marker so exactly one caller wins.
  // Two concurrent invocations can both pass requireElevation (read), but only
  // one rename succeeds — the loser finds the marker gone and is refused, so one
  // human elevation authorizes exactly one one-shot op. Env-var (KIT_ELEVATED)
  // grants have no marker file; the rename fails and is allowed (explicit CI
  // escape hatch).
  const markerPath = resolve(cwd, ELEVATION_FILE);
  try {
    const { rename, rm } = await import("node:fs/promises");
    await rename(markerPath, `${markerPath}.consumed`);
    await rm(`${markerPath}.consumed`).catch(() => {});
  } catch {
    if (process.env.KIT_ELEVATED !== "1") {
      const reason = `Elevation for "${operation}" was already consumed by a concurrent process.`;
      await auditElevationDecision(operation, false, reason, "none", cwd);
      return { ok: false, reason };
    }
  }
  consumedInProcess.add(operation);
  return result;
}

/**
 * Test-only: reset the in-process consumed-scope set. Public so tests can
 * exercise the one-shot semantics deterministically without spawning new
 * processes.
 */
export function _resetConsumedElevationForTests(): void {
  consumedInProcess.clear();
  warnedAboutCiBypass = false;
}
