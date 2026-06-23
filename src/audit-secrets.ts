/**
 * Forensics view on the audit log filtered to secret-touching operations.
 *
 * After a leak it's invaluable to know:
 *   - Which agent / user resolved each key, and when
 *   - Which migrate / rotate / register-fake / propagate events touched it
 *   - Whether the key appeared in any service-output that flowed to disk
 *
 * Reads `.kit-audit.jsonl` (the JSONL append-only log written by the
 * existing `logAuditEvent` helper). Filters + groups events per key.
 */

import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import type { AuditEvent } from "./audit.js";

export interface SecretAccessEntry {
  timestamp: string;
  operation: string;
  agent?: string;
  detail: string;
  success: boolean;
}

export interface SecretAuditReport {
  key: string;
  events: SecretAccessEntry[];
}

const AUDIT_FILE = ".kit-audit.jsonl";

const SECRET_OPERATIONS = new Set([
  "secrets.generate",
  "secrets.sync",
  "secrets.migrate",
  "secrets.rotate",
  "secrets.onecli.register",
  "secrets.propagate",
  "services.login",
  "fix",
]);

export async function readSecretAuditEvents(
  cwd: string = process.cwd(),
  sinceDays = 30,
): Promise<AuditEvent[]> {
  const path = resolve(cwd, AUDIT_FILE);
  try {
    await access(path);
  } catch {
    return [];
  }
  const text = await readFile(path, "utf-8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  const cutoff = Date.now() - sinceDays * 24 * 3600 * 1000;
  const events: AuditEvent[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as AuditEvent;
      if (!SECRET_OPERATIONS.has(e.operation)) continue;
      const ts = Date.parse(e.timestamp);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      events.push(e);
    } catch {
      // skip malformed line
    }
  }
  return events;
}

/**
 * Extracts secret-related event details, attempting to attribute each event
 * to one or more specific keys via the metadata payload.
 */
export function groupBySecret(events: AuditEvent[]): {
  reports: SecretAuditReport[];
  unattributed: SecretAccessEntry[];
} {
  const byKey = new Map<string, SecretAccessEntry[]>();
  const unattributed: SecretAccessEntry[] = [];

  for (const e of events) {
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    const keys = collectKeyNames(meta);
    const entry: SecretAccessEntry = {
      timestamp: e.timestamp,
      operation: e.operation,
      agent: e.agent_name ?? e.agent_id,
      detail: summarizeEvent(e),
      success: e.success,
    };
    if (keys.length === 0) {
      unattributed.push(entry);
      continue;
    }
    for (const k of keys) {
      const arr = byKey.get(k) ?? [];
      arr.push(entry);
      byKey.set(k, arr);
    }
  }

  const reports: SecretAuditReport[] = [...byKey.entries()]
    .map(([key, events]) => ({
      key,
      events: events.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    }))
    .sort((a, b) => b.events.length - a.events.length);

  return { reports, unattributed };
}

function collectKeyNames(meta: Record<string, unknown>): string[] {
  const names: string[] = [];
  if (typeof meta.key === "string") names.push(meta.key);
  if (Array.isArray(meta.keys)) {
    for (const k of meta.keys) if (typeof k === "string") names.push(k);
  }
  if (typeof meta.name === "string") names.push(meta.name);
  return [...new Set(names)];
}

function summarizeEvent(e: AuditEvent): string {
  const meta = (e.metadata ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof meta.store === "string") parts.push(`store=${meta.store}`);
  if (typeof meta.target === "string") parts.push(`target=${meta.target}`);
  if (typeof meta.source === "string") parts.push(`source=${meta.source}`);
  if (e.error) parts.push(`error=${e.error.split("\n")[0]}`);
  if (e.environment) parts.push(`env=${e.environment}`);
  return parts.join("  ");
}

export interface AuditSummary {
  totalEvents: number;
  keyCount: number;
  topKey?: { key: string; count: number };
  windowDays: number;
}

export function summarize(reports: SecretAuditReport[], windowDays: number): AuditSummary {
  const totalEvents = reports.reduce((sum, r) => sum + r.events.length, 0);
  const top = reports[0];
  return {
    totalEvents,
    keyCount: reports.length,
    topKey: top ? { key: top.key, count: top.events.length } : undefined,
    windowDays,
  };
}
