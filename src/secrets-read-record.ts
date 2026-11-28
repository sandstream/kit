/**
 * One audit event per secret read through kit: which keys, from which store, by which kit surface,
 * when, and who asked. Never a value, and never a hash of one.
 *
 * Writes have been recorded per key since `src/secrets-write-record.ts`, with `[governance]` on or
 * off. Reads were not: `kit secrets` with the default config wrote 0 audit events, because the only
 * record was the governed `secrets.generate`, and `withGovernance` returns before any audit when
 * governance is off (`if (!governanceConfig.enabled) { return await operation(); }`). The vault
 * backends, `kit run` and the exec-broker recorded no key names at all (kit-research
 * `kms-decrypt-evidence-vs-kit`, 2026-11-27). So "was X read through kit since T, and by whom?" had
 * nothing to answer from.
 *
 * This record goes through `appendAuditEventDirect`, the same hash-chained, anchored append the
 * write records use, so it does not depend on `[governance]`. What stays governance-only is
 * unchanged: permission, revocation, budget and approval checks, the config-declared agent stamp on
 * governed events, and the opt-in remote push (`logAuditEvent`).
 *
 * The record is written BEFORE the value is fetched or handed on, and a failed append refuses the
 * read (fail closed): a read kit cannot record is a read kit does not make. Because it precedes the
 * fetch, it also covers reads that then fail, so it can over-report a read, never under-report one.
 *
 * Coverage limit, stated wherever this is queried: these are reads THROUGH kit. A process that opens
 * `.env.local` itself is not visible to kit.
 */
import { appendAuditEventDirect, type AuditEvent } from "./audit.js";
import { detectAgentSession } from "./agent-session.js";
import type { InfisicalConfig, SecretKeyConfig } from "./config.js";
import { resolveViaBackend } from "./secret-backends.js";
import type { SecretResolveResult } from "./secrets.js";
import { keyNameMetadata } from "./secrets-write-record.js";

export const SECRET_READ_OP = "secrets.read";

/** The kit surface that read the secret. Recorded as `via`. */
export type SecretReadVia =
  | "kit secrets"
  | "kit secrets sync"
  | "kit secrets validate"
  | "kit secrets onecli"
  | "mcp kit_secrets"
  | "kit run"
  | "exec-broker"
  | "kit check"
  | "kit fix"
  | "branch-protection";

export interface SecretRead {
  /** Key NAMES read. Never a value. */
  keys: readonly string[];
  /** Where each key was read from, by name: a `[secrets.keys]` source (`aws-sm`), `.env.local`. */
  storeOf: (name: string) => string;
  via: SecretReadVia;
}

export interface SecretReadCaller {
  /** The governed project's directory: the record lands in ITS chain. Defaults to process.cwd(). */
  cwd?: string;
  /** `[governance.agent]` from `.kit.toml`, when the caller has the config. Self-declared. */
  agent?: { id?: string; name?: string };
}

/** Thrown when the read could not be recorded, before any value was fetched or handed on. */
export class SecretReadNotRecordedError extends Error {
  constructor(via: SecretReadVia) {
    super(
      `${via}: the secret read could not be recorded in the audit log (.kit-audit.jsonl), so kit did not read it (fail-closed). Run \`kit audit verify\`.`,
    );
    this.name = "SecretReadNotRecordedError";
  }
}

/** Group key names by store, in first-seen order. Pure. */
function byStore(read: SecretRead): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of new Set(read.keys)) {
    const store = read.storeOf(name);
    groups.set(store, [...(groups.get(store) ?? []), name]);
  }
  return groups;
}

/**
 * The audit events for one read, one per store. They carry key names under `name`/`names` (the
 * field the `kit audit secrets` view attributes by), the store, the kit surface, the agent harness
 * kit detected, and the self-declared agent. No value, no digest of a value. Pure.
 */
export function secretReadEvents(
  read: SecretRead,
  caller: SecretReadCaller = {},
  env: NodeJS.ProcessEnv = process.env,
): Omit<AuditEvent, "timestamp">[] {
  const harness = detectAgentSession(env);
  return [...byStore(read)].map(([store, names]) => ({
    operation: SECRET_READ_OP,
    environment: env.KIT_ENV ?? env.NODE_ENV ?? "unknown",
    success: true,
    ...(caller.agent?.id ? { agent_id: caller.agent.id } : {}),
    ...(caller.agent?.name ? { agent_name: caller.agent.name } : {}),
    metadata: {
      ...keyNameMetadata(names),
      store,
      via: read.via,
      ...(harness ? { harness } : {}),
    },
  }));
}

/**
 * Record the read, then let the caller fetch. Throws `SecretReadNotRecordedError` when an append
 * fails, so the caller never reads what it could not record. No keys, no record.
 */
export async function recordSecretRead(
  read: SecretRead,
  caller: SecretReadCaller = {},
): Promise<void> {
  if (read.keys.length === 0) return;
  for (const event of secretReadEvents(read, caller)) {
    if (!(await appendAuditEventDirect(event, { cwd: caller.cwd }))) {
      throw new SecretReadNotRecordedError(read.via);
    }
  }
}

/** Who reads, and with what: the kit surface, the project, its declared agent and Infisical settings. */
export interface SecretReader extends SecretReadCaller {
  via: SecretReadVia;
  infisical?: InfisicalConfig;
}

/** A reader from a loaded `.kit.toml`. Pure. */
export function readBy(
  via: SecretReadVia,
  config: {
    governance?: { agent?: SecretReadCaller["agent"] };
    secrets?: { infisical?: InfisicalConfig };
  },
  cwd?: string,
): SecretReader {
  return { via, cwd, agent: config.governance?.agent, infisical: config.secrets?.infisical };
}

/** One key through its backend, recorded first. A read that cannot be recorded throws. */
export async function resolveRecorded(
  name: string,
  config: SecretKeyConfig,
  reader: SecretReader,
): Promise<SecretResolveResult> {
  await recordSecretRead({ keys: [name], storeOf: () => config.source, via: reader.via }, reader);
  return resolveViaBackend(name, config, reader.infisical, reader.cwd);
}
