/**
 * Per-session read-only mode.
 *
 * When kit is invoked with `--read-only` (or `.kit.toml [policy]
 * .default_mode = "read-only"`), every write-capable code path refuses
 * the mutation and audit-logs the refusal. The set of guarded operations
 * includes: vault writes, env-var sets, hook installs, elevation grants,
 * and every plugin's create/update/delete surface.
 *
 * Implementation choice: a single env var `KIT_READ_ONLY=1` is the
 * source of truth so plugins running in the same process tree honor the
 * flag without explicit coupling to a TypeScript module.
 */

import { appendAuditEventDirect } from "./audit.js";

const READ_ONLY_ENV = "KIT_READ_ONLY";

/**
 * Returns true when the active process should refuse mutating operations.
 * Honors:
 *   1. Explicit `--read-only` flag (parsed by main(), sets env var)
 *   2. `KIT_READ_ONLY=1` env var (for nested invocations)
 *   3. `.kit.toml [policy].default_mode = "read-only"` (read at boot)
 */
export function isReadOnlyMode(): boolean {
  const v = process.env[READ_ONLY_ENV];
  return v === "1" || v === "true";
}

/**
 * Activates read-only mode for this process and any child processes.
 * Idempotent. Called from main() after argv parsing or from
 * `.kit.toml`-policy loader.
 */
export function activateReadOnlyMode(source: "flag" | "env" | "policy"): void {
  if (isReadOnlyMode()) return;
  process.env[READ_ONLY_ENV] = "1";
  process.stderr.write(
    `[kit] read-only mode active (source: ${source}) — all writes will be refused.\n`,
  );
  void appendAuditEventDirect({
    operation: "read-only-mode-activated",
    environment: process.env.NODE_ENV ?? "unknown",
    success: true,
    metadata: { source },
  });
}

/**
 * Refuses a mutating operation. Returns a structured result that callers
 * forward; also appends an audit-log entry. Never throws — callers handle
 * the {ok: false} branch and surface the reason to the user.
 *
 * Pattern:
 *   if (isReadOnlyMode()) {
 *     const refusal = await refuseWrite("rotate-jwt", { vault: "supabase" });
 *     return { ok: false, detail: refusal.reason };
 *   }
 */
export async function refuseWrite(
  operation: string,
  metadata: Record<string, unknown> = {},
): Promise<{ ok: false; reason: string }> {
  const reason = `read-only mode active — refusing "${operation}"`;
  await appendAuditEventDirect({
    operation: "read-only-mode-refusal",
    environment: process.env.NODE_ENV ?? "unknown",
    success: false,
    metadata: { refused_operation: operation, ...metadata },
  });
  return { ok: false, reason };
}

/**
 * Test-only: reset env var so tests can exercise both modes.
 */
export function _resetReadOnlyModeForTests(): void {
  delete process.env[READ_ONLY_ENV];
}
