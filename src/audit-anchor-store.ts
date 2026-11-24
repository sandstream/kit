import { lstatSync, type BigIntStats } from "node:fs";
import { readFile, mkdir, open, stat, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AnchorRecord } from "./audit-anchor.js";
import { canonicalAuditLogPath } from "./audit-log-path.js";
import { secureFileStrictAsync } from "./utils/secure-perms.js";
import { identityOf, sameIdentity } from "./utils/same-file.js";
import { externalReceiptIdentity, validExternalStatement } from "./audit-external.js";

export type AnchorStore = Record<string, AnchorRecord>;

export class AuditAnchorIndexAccessError extends Error {}

export async function readAnchorStore(path: string): Promise<AnchorStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected an anchor index object.");
    }
    if (!Object.values(parsed).every(isAnchorRecord)) {
      throw new Error("Invalid anchor record.");
    }
    return parsed as AnchorStore;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    const Failure = code === "EACCES" || code === "EPERM" ? AuditAnchorIndexAccessError : Error;
    // Parser errors can disclose index content.
    throw new Failure(
      "The audit anchor index is unreadable or invalid. Preserve it before recovery.",
    );
  }
}

function isAnchorRecord(value: unknown): value is AnchorRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tip === "string" &&
    /^[a-f0-9]{64}$/i.test(record.tip) &&
    Number.isSafeInteger(record.count) &&
    (record.count as number) >= 0 &&
    record.algo === "hmac-sha256" &&
    typeof record.updatedAt === "string" &&
    validExternalReceipt(record.external)
  );
}

function validExternalReceipt(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    ["token", "authority", "timestamp"].every(
      (field) => typeof receipt[field] === "string" && receipt[field].trim().length > 0,
    ) &&
    (receipt.statement === undefined || validExternalStatement(receipt.statement))
  );
}

function sameLog(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    const first = canonicalAuditLogPath(left),
      second = canonicalAuditLogPath(right);
    return first === second || sameIdentity(identityOf(first), identityOf(second));
  } catch {
    return false;
  }
}

export function findAnchorRecord(store: AnchorStore, logPath: string): AnchorRecord | null {
  const matches = Object.entries(store).filter(([path]) => sameLog(path, logPath));
  const first = matches[0]?.[1];
  if (!first) return null;
  for (const [, record] of matches.slice(1)) {
    assertSameAnchor(first, record);
  }
  return first;
}

function assertSameAnchor(first: AnchorRecord, record: AnchorRecord): void {
  if (
    record.tip !== first.tip ||
    record.count !== first.count ||
    record.version !== first.version ||
    record.keyFingerprint !== first.keyFingerprint ||
    externalReceiptIdentity(record.external) !== externalReceiptIdentity(first.external)
  ) {
    throw new Error(
      "Conflicting audit anchors refer to the same log. Preserve the index and inspect both records.",
    );
  }
}

function aliasKeys(logPath: string): string[] {
  let canonical: string;
  try {
    canonical = canonicalAuditLogPath(logPath);
  } catch {
    return [`path:${logPath}`];
  }
  const keys = [`path:${canonical}`];
  try {
    const identity = identityOf(canonical);
    if (identity && identity.ino !== 0n) keys.push(`file:${identity.dev}:${identity.ino}`);
  } catch {
    // The canonical path still identifies aliases when file metadata is unavailable.
  }
  return keys;
}

/** Validate aliases once per path while retaining every stored path in the union. */
export function listAnchorRecords(
  store: AnchorStore,
): Array<{ logPath: string; record: AnchorRecord }> {
  const seen = new Map<string, AnchorRecord>();
  return Object.keys(store)
    .sort()
    .map((logPath) => {
      const record = store[logPath];
      for (const key of aliasKeys(logPath)) {
        const previous = seen.get(key);
        if (previous) assertSameAnchor(previous, record);
        seen.set(key, record);
      }
      return { logPath, record };
    });
}

export interface PreparedAnchorStore {
  path: string;
  temporary: string;
  handle: FileHandle;
  parent: BigIntStats;
  identity: BigIntStats;
}

function stagedFileIsOwned(prepared: PreparedAnchorStore): boolean {
  const parent = lstatSync(dirname(prepared.path), { bigint: true, throwIfNoEntry: false });
  const entry = lstatSync(prepared.temporary, { bigint: true, throwIfNoEntry: false });
  return !!(
    parent?.isDirectory() &&
    sameIdentity(parent, prepared.parent) &&
    entry?.isFile() &&
    entry.nlink === 1n &&
    sameIdentity(entry, prepared.identity)
  );
}

function assertStagedFile(prepared: PreparedAnchorStore): void {
  if (!stagedFileIsOwned(prepared)) throw new Error("The prepared audit anchor changed.");
}

export async function closePreparedAnchorStore(prepared: PreparedAnchorStore): Promise<void> {
  try {
    if (stagedFileIsOwned(prepared)) {
      await unlink(prepared.temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  } finally {
    await prepared.handle.close();
  }
}

/** Secure an empty replacement before acquiring either audit lock. */
export async function prepareAnchorStore(path: string): Promise<PreparedAnchorStore> {
  await mkdir(dirname(path), { recursive: true });
  const canonical = canonicalAuditLogPath(path);
  const directory = dirname(canonical);
  const parent = lstatSync(directory, { bigint: true });
  const temporary = join(directory, `.kit-audit-index-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let prepared: PreparedAnchorStore | undefined;
  try {
    prepared = {
      path: canonical,
      temporary,
      handle,
      parent,
      identity: await handle.stat({ bigint: true }),
    };
    assertStagedFile(prepared);
    await secureFileStrictAsync(temporary);
    assertStagedFile(prepared);
    return prepared;
  } catch (error) {
    if (prepared) await closePreparedAnchorStore(prepared);
    else await handle.close();
    throw error;
  }
}

/** Merge and atomically publish one seal while other logs retain their records. */
export async function storeAnchorRecord(
  prepared: PreparedAnchorStore,
  logPath: string,
  record: AnchorRecord,
): Promise<void> {
  const canonical = prepared.path;
  const { withSqliteMutex } = await import("./sqlite-mutex.js");
  await withSqliteMutex(`${canonical}.lock.sqlite`, async () => {
    assertStagedFile(prepared);
    if (canonicalAuditLogPath(canonical) !== canonical)
      throw new Error("The audit anchor index path changed.");
    const store = await readAnchorStore(canonical);
    for (const storedPath of Object.keys(store)) {
      if (sameLog(storedPath, logPath)) {
        delete store[storedPath];
        continue;
      }
      try {
        await stat(storedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") delete store[storedPath];
      }
    }
    store[canonicalAuditLogPath(logPath)] = record;
    await prepared.handle.writeFile(JSON.stringify(store, null, 2) + "\n", "utf8");
    assertStagedFile(prepared);
    if (canonicalAuditLogPath(canonical) !== canonical)
      throw new Error("The audit anchor index path changed.");
    await rename(prepared.temporary, canonical);
  });
}
