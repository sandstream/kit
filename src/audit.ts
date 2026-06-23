import { appendFile, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { GovernanceConfig } from "./config.js";

// ── Tamper-evident hash chain ───────────────────────────────────────────────
// Each appended line carries `prev` (the previous line's hash) and `hash`
// (sha256 over the line's canonical pre-hash JSON). Any edit, insertion,
// deletion, or reorder breaks the chain and is caught by verifyAuditChain —
// the integrity property a regulated/air-gapped enclave needs from its audit
// trail. (Note: cross-process concurrent appends can fork the chain; external
// tampering is still detected.)
const GENESIS_HASH = "0".repeat(64);

function hashLine(preHashJson: string): string {
  return createHash("sha256").update(preHashJson).digest("hex");
}

/** Read the last entry's hash to chain onto, or GENESIS for a fresh/legacy log. */
async function lastChainHash(logPath: string): Promise<string> {
  try {
    const content = await readFile(logPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) return GENESIS_HASH;
    const last = JSON.parse(lines[lines.length - 1]) as { hash?: unknown };
    return typeof last.hash === "string" ? last.hash : GENESIS_HASH;
  } catch {
    return GENESIS_HASH;
  }
}

/** Append an event as a hash-chained line. Throws on write failure. */
async function appendChained(logPath: string, event: AuditEvent): Promise<void> {
  const prev = await lastChainHash(logPath);
  const preHash = JSON.stringify({ ...event, prev });
  const hash = hashLine(preHash);
  await appendFile(logPath, JSON.stringify({ ...event, prev, hash }) + "\n", "utf-8");
}

export interface ChainVerifyResult {
  ok: boolean;
  entries: number;
  /** 0-based index of the first broken entry, when !ok. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Re-walk a `.kit-audit.jsonl` body and verify the hash chain end to end.
 * Detects content tampering (hash mismatch) and insertion/deletion/reorder
 * (prev-link mismatch). Pure — fully testable.
 */
export function verifyAuditChain(content: string): ChainVerifyResult {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  let prev = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      return { ok: false, entries: i, brokenAt: i, reason: "unparseable line" };
    }
    const { hash, ...rest } = obj;
    if (typeof hash !== "string") {
      return { ok: false, entries: i, brokenAt: i, reason: "missing hash (unchained entry)" };
    }
    if (rest.prev !== prev) {
      return {
        ok: false,
        entries: i,
        brokenAt: i,
        reason: "broken link — an entry was inserted, removed, or reordered",
      };
    }
    if (hashLine(JSON.stringify(rest)) !== hash) {
      return {
        ok: false,
        entries: i,
        brokenAt: i,
        reason: "hash mismatch — entry content tampered",
      };
    }
    prev = hash;
  }
  return { ok: true, entries: lines.length };
}

const PENDING_QUEUE_FILE = ".kit-audit.pending";
const MAX_PENDING_ENTRIES = 500;
const RETRY_BACKOFF_MS = [250, 1_000, 4_000];

export interface AuditEvent {
  timestamp: string;
  agent_id?: string;
  agent_name?: string;
  operation: string;
  environment: string;
  success: boolean;
  duration_ms?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append an audit event directly to .kit-audit.jsonl without requiring a
 * governance config to be loaded. Used by code paths that *must* log without
 * the possibility of being short-circuited by missing config — primarily the
 * elevation gate, the prod-key bypass, and the rate-limiter fail-open hatch.
 *
 * Returns true on success, false if the append failed. Callers that gate
 * destructive ops on auditability should treat `false` as "do not proceed".
 *
 * `cwd` lets tests/hooks point at a sandbox; production callers pass nothing.
 */
export async function appendAuditEventDirect(
  event: Omit<AuditEvent, "timestamp">,
  opts: { cwd?: string; logFile?: string } = {},
): Promise<boolean> {
  const auditEvent: AuditEvent = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  const logFile = opts.logFile ?? ".kit-audit.jsonl";
  const logPath = resolve(opts.cwd ?? process.cwd(), logFile);
  try {
    await appendChained(logPath, auditEvent);
    return true;
  } catch (error) {
    console.error(`[kit] audit-log append failed: ${error}`);
    return false;
  }
}

/**
 * POST a single audit event to Remote with bounded exponential-backoff
 * retries. Returns true on success, false if all attempts fail. The caller
 * uses the boolean to decide whether to park the event in the pending queue.
 */
async function postToRemoteOnce(event: AuditEvent, companyId: string): Promise<boolean> {
  const apiUrl = process.env.KIT_REMOTE_URL || "http://localhost:3199";
  const url = `${apiUrl}/api/companies/${companyId}/audit-logs`;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) return true;
      // 4xx is a permanent failure — no point retrying a malformed event.
      if (response.status >= 400 && response.status < 500) {
        console.error(`Remote audit-log rejected (${response.status}); not retrying.`);
        return false;
      }
    } catch (error) {
      // Transient — fall through to backoff/retry.
      if (attempt === RETRY_BACKOFF_MS.length) {
        console.error(
          `Remote audit-log final-attempt failed: ${error instanceof Error ? error.message : error}`,
        );
        return false;
      }
    }
    const delay = RETRY_BACKOFF_MS[attempt];
    if (delay !== undefined) {
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  return false;
}

interface PendingEntry {
  event: AuditEvent;
  companyId: string;
  parkedAt: string;
}

/**
 * Append a failed-to-send event to .kit-audit.pending so the next audit
 * call can drain it. Bounded to MAX_PENDING_ENTRIES so a long outage
 * doesn't grow the file without limit.
 */
async function parkPendingEntry(event: AuditEvent, companyId: string): Promise<void> {
  const entry: PendingEntry = {
    event,
    companyId,
    parkedAt: new Date().toISOString(),
  };
  const queuePath = resolve(process.cwd(), PENDING_QUEUE_FILE);
  try {
    let existing = "";
    try {
      existing = await readFile(queuePath, "utf-8");
    } catch {
      /* no queue yet */
    }
    const lines = existing.split("\n").filter((l) => l.trim().length > 0);
    lines.push(JSON.stringify(entry));
    // Drop oldest entries when over cap.
    const trimmed = lines.slice(-MAX_PENDING_ENTRIES);
    await writeFile(queuePath, trimmed.join("\n") + "\n", "utf-8");
  } catch (error) {
    console.error(`Failed to park pending audit event: ${error}`);
  }
}

/**
 * Attempt to flush any parked events. Best-effort: events that fail again
 * stay in the queue (rewritten atomically via tmp + rename so a crash
 * mid-drain doesn't lose entries). Called opportunistically from
 * logAuditEvent so the queue drains whenever the API is reachable.
 */
async function drainPendingQueue(): Promise<void> {
  const queuePath = resolve(process.cwd(), PENDING_QUEUE_FILE);
  let content = "";
  try {
    content = await readFile(queuePath, "utf-8");
  } catch {
    return; // no queue
  }
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;
  const remaining: string[] = [];
  for (const line of lines) {
    let entry: PendingEntry;
    try {
      entry = JSON.parse(line) as PendingEntry;
    } catch {
      // Drop malformed line.
      continue;
    }
    const sent = await postToRemoteOnce(entry.event, entry.companyId);
    if (!sent) remaining.push(line);
  }
  if (remaining.length === lines.length) return; // nothing drained, leave file as-is
  const tmpPath = `${queuePath}.tmp`;
  try {
    await writeFile(tmpPath, remaining.length ? remaining.join("\n") + "\n" : "", "utf-8");
    await rename(tmpPath, queuePath);
  } catch (error) {
    console.error(`Failed to rewrite pending queue: ${error}`);
  }
}

/**
 * Send audit event to Remote API with retry queue. Caller is non-blocking
 * — they don't await the network round-trip; the queue catches up next call.
 */
async function sendToRemoteAPI(event: AuditEvent, companyId: string): Promise<void> {
  // Opportunistically drain prior failures first — if the API is up, we
  // clear the backlog before adding this event.
  await drainPendingQueue();
  const ok = await postToRemoteOnce(event, companyId);
  if (!ok) {
    await parkPendingEntry(event, companyId);
  }
}

/**
 * Log an audit event to the configured audit log file and Remote API
 */
export async function logAuditEvent(
  config: Required<GovernanceConfig>,
  event: Omit<AuditEvent, "timestamp" | "agent_id" | "agent_name">,
  companyId?: string,
): Promise<void> {
  if (!config.audit.enabled) {
    return;
  }

  const auditEvent: AuditEvent = {
    timestamp: new Date().toISOString(),
    agent_id: config.agent.id,
    agent_name: config.agent.name,
    ...event,
  };

  // Remove secrets from metadata if include_secrets is false
  if (!config.audit.include_secrets && auditEvent.metadata) {
    auditEvent.metadata = sanitizeMetadata(auditEvent.metadata);
  }

  // Write to local JSONL file (hash-chained for tamper-evidence)
  const logFile = config.audit.log_file || ".kit-audit.jsonl";
  const logPath = resolve(process.cwd(), logFile);

  try {
    await appendChained(logPath, auditEvent);
  } catch (error) {
    console.error(`Failed to write audit log: ${error}`);
  }

  // Send to Remote API only when audit.remote is explicitly enabled in
  // the governance config. Default off — audit-log stays local-first per
  // docs/THREAT_MODEL.md. Operators opt in by setting
  // `[governance.audit].remote = true` in .kit.toml.
  if (companyId && config.audit.remote === true) {
    warnFirstRemotePush(companyId);
    await sendToRemoteAPI(auditEvent, companyId);
  }
}

/**
 * Emits a one-time stderr notice when audit-log starts shipping events to a
 * remote endpoint. The notice is surfacing the data-residency choice the
 * operator made — silent shipping would violate the threat-model contract.
 */
let warnedRemotePush = false;
function warnFirstRemotePush(companyId: string): void {
  if (warnedRemotePush) return;
  warnedRemotePush = true;
  const apiUrl = process.env.KIT_REMOTE_URL || "http://localhost:3199";
  console.error(
    `[kit] NOTICE: [governance.audit].remote=true — shipping audit events to ${apiUrl} (company ${companyId}). ` +
      `Disable in .kit.toml to keep audit-log local-only.`,
  );
}

/**
 * Test-only: reset the module-scoped warning flag.
 */
export function _resetRemotePushWarningForTests(): void {
  warnedRemotePush = false;
}

/**
 * Sanitize metadata to remove potential secrets
 */
function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const secretKeys = [
    "password",
    "secret",
    "token",
    "key",
    "api_key",
    "apikey",
    "auth",
    "credential",
  ];

  for (const [key, value] of Object.entries(metadata)) {
    const lowerKey = key.toLowerCase();
    const isSecret = secretKeys.some((secretKey) => lowerKey.includes(secretKey));

    if (isSecret) {
      sanitized[key] = "[REDACTED]";
    } else if (value && typeof value === "object") {
      sanitized[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Read recent audit log entries
 */
export async function readAuditLog(logFile: string, limit = 100): Promise<AuditEvent[]> {
  const { readFile } = await import("node:fs/promises");
  const logPath = resolve(process.cwd(), logFile);

  try {
    const content = await readFile(logPath, "utf-8");
    const lines = content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);

    // Get last N lines
    const recentLines = lines.slice(-limit);

    return recentLines.map((line) => JSON.parse(line) as AuditEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return []; // No log file yet
    }
    throw error;
  }
}

/**
 * Format audit log for display
 */
export function formatAuditLog(events: AuditEvent[]): string {
  if (events.length === 0) {
    return "No audit log entries found.";
  }

  const lines: string[] = [];

  for (const event of events) {
    const timestamp = new Date(event.timestamp).toLocaleString();
    const status = event.success ? "✓" : "✗";
    const duration = event.duration_ms ? ` (${event.duration_ms}ms)` : "";
    const agent = event.agent_name || event.agent_id || "unknown";

    lines.push(
      `${timestamp} ${status} ${event.operation}${duration} [${event.environment}] by ${agent}`,
    );

    if (event.error) {
      lines.push(`  Error: ${event.error}`);
    }

    if (event.metadata && Object.keys(event.metadata).length > 0) {
      lines.push(`  Metadata: ${JSON.stringify(event.metadata)}`);
    }
  }

  return lines.join("\n");
}
