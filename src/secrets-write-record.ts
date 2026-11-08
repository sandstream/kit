/**
 * One audit event per secret write: which key, where it went, and whether the write succeeded.
 * Never the value.
 *
 * `src/audit-secrets.ts` (the forensics view behind `kit audit secrets`) filters the log for
 * `secrets.sync`, `secrets.migrate`, `secrets.rotate`, `secrets.onecli.register` and
 * `secrets.propagate`, and promised "which migrate / rotate / register-fake / propagate events
 * touched it". Until this module nothing wrote those operations: only `secrets.generate` was ever
 * logged, and the view's tests passed on fixture lines they wrote themselves (kit-research
 * `theo-t3-ten-videos-vs-kit`, 2026-11-08). After a provider breach, "which of my keys did kit push
 * to that provider?" had no record to answer from.
 *
 * The operation names are the view's, so writer and reader share one constant.
 */
import { appendAuditEventDirect, type AuditEvent } from "./audit.js";

export const SECRET_WRITE_OPS = {
  propagate: "secrets.propagate",
  sync: "secrets.sync",
  rotate: "secrets.rotate",
  migrate: "secrets.migrate",
  onecliRegister: "secrets.onecli.register",
} as const;

export type SecretWriteOp = (typeof SECRET_WRITE_OPS)[keyof typeof SECRET_WRITE_OPS];

export interface SecretWrite {
  /** Key NAMES written. Never a value. */
  keys: string[];
  /** Where they went: a platform (`railway`), a vault store, `onecli`, `.env.ci`, `stdout`. */
  target: string;
  ok: boolean;
}

/** The audit event for one write. Carries no value and no error text (which could echo one). Pure. */
export function secretWriteEvent(
  op: SecretWriteOp,
  write: SecretWrite,
  env: Record<string, string | undefined> = process.env,
): Omit<AuditEvent, "timestamp"> {
  const keys = [...new Set(write.keys)];
  return {
    operation: op,
    environment: env.KIT_ENV ?? env.NODE_ENV ?? "unknown",
    success: write.ok,
    // `name`/`names`, not `key`/`keys`: the audit log redacts every metadata field whose name
    // contains "key", "secret" or "token" (sanitizeMetadata in audit.ts), which would leave the
    // view grouping every write under "[REDACTED]".
    metadata: {
      ...(keys.length === 1 ? { name: keys[0] } : { names: keys }),
      target: write.target,
    },
  };
}

/**
 * Append the event to the project's hash-chained audit log. Best-effort like every other direct
 * append: a failed append is reported on stderr by `appendAuditEventDirect` and never stops the
 * write it describes, which has already happened.
 */
export async function recordSecretWrite(
  op: SecretWriteOp,
  write: SecretWrite,
  opts: { cwd?: string } = {},
): Promise<void> {
  if (write.keys.length === 0) return;
  await appendAuditEventDirect(secretWriteEvent(op, write), { cwd: opts.cwd });
}
