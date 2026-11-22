/**
 * `kit audit verify` when the log is missing, or exists and holds no entry.
 *
 * Nothing was verified in either case, and the two cases are separate outcomes. An empty log
 * is not "an intact chain with 0 entries": a log that was emptied would then read the same as
 * a log that verifies.
 *
 * Verify-by-absence is false security, so the outcome fails when the caller requires a
 * verified log (`--strict`, `require_anchor`, `--require-external`) or when this machine has
 * anchored logs, where an erased trail is a tamper signal. On a fresh install it is a
 * warning, never a silent pass.
 */
export interface NothingVerified {
  ok: boolean;
  /** Stable text for the JSON report. */
  reason: string;
  /** Text for a person. */
  message: string;
}

export function nothingVerified(
  kind: "missing" | "empty",
  logPath: string,
  failClosed: boolean,
): NothingVerified {
  const missing = kind === "missing";
  const reason = missing
    ? "audit log unavailable; nothing verified"
    : "audit log is empty; nothing verified";
  const what = missing ? `no audit log at ${logPath}` : `the audit log at ${logPath} is empty`;
  if (failClosed) {
    return {
      ok: false,
      reason,
      message: `${what} — refusing to report verified under strict / require_anchor / a machine that has anchored logs. An erased trail is a tamper signal, not a pass.`,
    };
  }
  const state = missing ? "yet — nothing to verify (fresh install)" : "(nothing verified)";
  return { ok: true, reason, message: `${what} ${state}` };
}
