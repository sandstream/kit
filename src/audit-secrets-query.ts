/**
 * `kit audit secrets --key <NAME> --since <ISO>`: was this key read or written THROUGH kit since T,
 * and by whom, answered from the hash-chained audit log, with the chain verified first.
 *
 * The older view (`kit audit secrets --key X --since-days N`) groups events per key but never says
 * what it cannot see, nor whether the log it read is intact. An answer to "was X read since T?"
 * that a reader may hand to a regulator has to say both (kit-research `kms-decrypt-evidence-vs-kit`,
 * 2026-11-27). So this answer always carries:
 *
 *   - its coverage, in words: reads through kit only. A process that opens `.env.local` itself
 *     leaves no record here;
 *   - the chain verdict: the keyless hash chain, then the machine-local HMAC anchor when one
 *     exists. A broken chain, or a failed anchor, makes the command exit non-zero;
 *   - the secret events in the window that name NO key (written before kit recorded key names),
 *     which may include this key.
 *
 * Names only, never values: the events it reads carry none.
 */
import { readFile } from "node:fs/promises";
import { verifyAuditChain, type AuditEvent } from "./audit.js";
import type { AnchorVerdict } from "./audit-anchor.js";
import { canonicalAuditLogPath } from "./audit-log-path.js";
import { INCIDENT_AUDIT_OP } from "./secrets-incident.js";
import { SECRET_WRITE_OPS } from "./secrets-write-record.js";

export const COVERAGE =
  "reads through kit only; processes that read .env.local directly are not visible";

/**
 * Reads: `secrets.read` (every resolve or injection, `src/secrets-read-record.ts`), the governed
 * `secrets.generate`, and `kit secrets incident`, which reads each value to fingerprint it.
 */
const READ_OPS = new Set<string>(["secrets.read", "secrets.generate", INCIDENT_AUDIT_OP]);
const WRITE_OPS = new Set<string>(Object.values(SECRET_WRITE_OPS));
/** Secret-touching operations that are neither: they still answer "was X touched". */
const OTHER_OPS = new Set<string>(["services.login", "fix"]);

export interface KeyAccessEvent {
  timestamp: string;
  kind: "read" | "write" | "other";
  operation: string;
  success: boolean;
  /** Who: the self-declared agent, the harness kit detected, the kit surface. Absent when unknown. */
  agent?: string;
  harness?: string;
  via?: string;
  /** Where from (a read's store) or to (a write's target). */
  store?: string;
  target?: string;
}

export interface ChainState {
  verified: boolean;
  status: "intact" | "broken" | "missing" | "empty" | "anchor-failed";
  entries: number;
  detail: string;
}

export interface KeyAccessAnswer {
  key: string;
  since: string;
  coverage: string;
  chain: ChainState;
  reads: number;
  writes: number;
  events: KeyAccessEvent[];
  /** Secret events in the window that name no key. They may include this one. */
  unattributed: number;
}

function namesOf(meta: Record<string, unknown>): string[] {
  const names = Array.isArray(meta.names) ? meta.names : [];
  return [meta.name, meta.key, ...names].filter((n): n is string => typeof n === "string");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function kindOf(operation: string): KeyAccessEvent["kind"] | undefined {
  if (READ_OPS.has(operation)) return "read";
  if (WRITE_OPS.has(operation)) return "write";
  return OTHER_OPS.has(operation) ? "other" : undefined;
}

function toAccess(e: AuditEvent, kind: KeyAccessEvent["kind"]): KeyAccessEvent {
  const meta = e.metadata ?? {};
  const entry: KeyAccessEvent = {
    timestamp: e.timestamp,
    kind,
    operation: e.operation,
    success: e.success,
    agent: str(e.agent_name) ?? str(e.agent_id),
    harness: str(meta.harness),
    via: str(meta.via),
    store: str(meta.store),
    target: str(meta.target),
  };
  for (const field of Object.keys(entry) as (keyof KeyAccessEvent)[])
    if (entry[field] === undefined) delete entry[field];
  return entry;
}

function parse(line: string): AuditEvent | undefined {
  try {
    return JSON.parse(line) as AuditEvent;
  } catch {
    return undefined;
  }
}

/** The events for `key` at or after `since`, oldest first. The chain is the caller's. Pure. */
export function answerKeyAccess(
  content: string,
  key: string,
  since: Date,
): Omit<KeyAccessAnswer, "chain"> {
  const events: KeyAccessEvent[] = [];
  let unattributed = 0;
  for (const line of content.split("\n")) {
    const e = line.trim() ? parse(line) : undefined;
    const kind = e && kindOf(e.operation);
    if (!e || !kind || !(Date.parse(e.timestamp) >= since.getTime())) continue;
    const names = namesOf(e.metadata ?? {});
    if (names.length === 0) unattributed++;
    else if (names.includes(key)) events.push(toAccess(e, kind));
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const count = (kind: KeyAccessEvent["kind"]) => events.filter((e) => e.kind === kind).length;
  return {
    key,
    since: since.toISOString(),
    coverage: COVERAGE,
    reads: count("read"),
    writes: count("write"),
    events,
    unattributed,
  };
}

/** The anchor verdict, non-strict: what `kit audit verify` without `--strict` would say. */
async function anchorVerdict(logPath: string, content: string): Promise<AnchorVerdict> {
  const anchor = await import("./audit-anchor.js");
  const result = anchor.verifyAgainstAnchor(
    content,
    await anchor.readAnchorRecord(logPath),
    await anchor.tryReadAuditAnchorKey(),
  );
  return anchor.decideAnchorVerdict({
    result,
    strict: false,
    machineHasAnchors: await anchor.hasAnyAnchoredLogs(),
    requireExternal: false,
  });
}

/** Verify the keyless chain, then the anchor. A missing or empty log verifies nothing. */
async function verifyChainFor(logPath: string, content: string | null): Promise<ChainState> {
  if (content === null)
    return { verified: false, status: "missing", entries: 0, detail: `no audit log at ${logPath}` };
  if (content.trim() === "")
    return { verified: false, status: "empty", entries: 0, detail: "the audit log is empty" };
  const chain = verifyAuditChain(content);
  if (!chain.ok) {
    const detail = `BROKEN at entry ${chain.brokenAt}: ${chain.reason}`;
    return { verified: false, status: "broken", entries: chain.entries, detail };
  }
  const verdict = await anchorVerdict(logPath, content);
  if (!verdict.ok)
    return {
      verified: false,
      status: "anchor-failed",
      entries: chain.entries,
      detail: verdict.message,
    };
  return { verified: true, status: "intact", entries: chain.entries, detail: verdict.message };
}

async function readLog(logPath: string): Promise<string | null> {
  try {
    return await readFile(canonicalAuditLogPath(logPath), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Read the log once, verify it, and answer from that same snapshot. */
export async function queryKeyAccess(
  logPath: string,
  key: string,
  since: Date,
): Promise<KeyAccessAnswer> {
  const content = await readLog(logPath);
  const chain = await verifyChainFor(logPath, content);
  return { ...answerKeyAccess(content ?? "", key, since), chain };
}
