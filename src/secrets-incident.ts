/**
 * `kit secrets incident <backend>` — the fingerprint snapshot behind a vendor-incident response.
 *
 * kit-research#232 (1Password's November 2026 incident): kit could neither list the keys it sources
 * from one backend nor tell whether a rotation actually changed a value (`secrets validate` checks
 * that a key resolves, not that it changed). This module takes a keyed fingerprint of every value
 * before rotation and compares after it.
 *
 * Fingerprints are HMAC-SHA256 under a random 32-byte key generated per snapshot, never a plain
 * hash. That defeats precomputed tables and makes two snapshots (or two machines) incomparable.
 * The key sits in the same owner-only, gitignored file, so whoever can read the file can still
 * test guesses for one key; the file's protection is the 0600/ACL mode and the ignore rule, both
 * checked before any read or write here.
 *
 * Owner direction "trust no one" (2026-11-26):
 *  - a value that cannot be re-read is NOT verified, never "changed";
 *  - a snapshot that is missing, unreadable, too widely readable, for another backend or for a
 *    different key list is an error, never a silent re-snapshot (`--new-snapshot` replaces one);
 *  - nothing here changes a remote credential. Rotation stays a person's step.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execFileNoThrow } from "./utils/execFileNoThrow.js";
import {
  privateFileIsControlled,
  secureDirStrict,
  secureFileStrictAsync,
} from "./utils/secure-perms.js";

export const SNAPSHOT_VERSION = 1;
/** Audit operation for every `kit secrets incident` run; `kit audit secrets` lists it per key. */
export const INCIDENT_AUDIT_OP = "secrets.incident";
const SNAPSHOT_KIND = "kit-secrets-incident-snapshot";

export interface SnapshotKey {
  name: string;
  /** HMAC-SHA256 hex of the value, or null when the value could not be read at snapshot time. */
  fingerprint: string | null;
}

export interface Snapshot {
  version: number;
  kind: string;
  backend: string;
  createdAt: string;
  /** The CLI the values were read through, as resolved at snapshot time (null: no CLI). */
  cli: string | null;
  /** base64 of the random per-snapshot HMAC key. */
  hmacKey: string;
  keys: SnapshotKey[];
}

/** A value read for fingerprinting. `value` never leaves this module's callers' memory. */
export interface ReadValue {
  name: string;
  value: string | null;
}

export type VerifyOutcome = "changed" | "unchanged" | "unresolvable" | "no-baseline";

export interface VerifyRow {
  name: string;
  outcome: VerifyOutcome;
}

export type LoadResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: string };

/** `.kit/incident/<backend>.json` under the project root. `.kit/*` is a required ignore rule. */
export function snapshotPath(cwd: string, backend: string): string {
  return join(cwd, ".kit", "incident", `${backend}.json`);
}

export function fingerprint(hmacKey: Buffer, value: string): string {
  return createHmac("sha256", hmacKey).update(value, "utf8").digest("hex");
}

/** Build a snapshot from values already read. Pure apart from the random key. */
export function buildSnapshot(
  backend: string,
  values: ReadValue[],
  cli: string | null,
  now: Date = new Date(),
): Snapshot {
  const key = randomBytes(32);
  return {
    version: SNAPSHOT_VERSION,
    kind: SNAPSHOT_KIND,
    backend,
    createdAt: now.toISOString(),
    cli,
    hmacKey: key.toString("base64"),
    keys: values
      .map((v) => ({ name: v.name, fingerprint: v.value ? fingerprint(key, v.value) : null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function sameFingerprint(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Compare current values against a snapshot. Only a re-read, different value counts as changed. */
export function compareSnapshot(snapshot: Snapshot, current: ReadValue[]): VerifyRow[] {
  const key = Buffer.from(snapshot.hmacKey, "base64");
  const now = new Map(current.map((v) => [v.name, v.value]));
  return snapshot.keys.map(({ name, fingerprint: before }) => {
    const value = now.get(name);
    if (!value) return { name, outcome: "unresolvable" };
    if (before === null) return { name, outcome: "no-baseline" };
    return {
      name,
      outcome: sameFingerprint(before, fingerprint(key, value)) ? "unchanged" : "changed",
    };
  });
}

/** Exit status for `--verify`: success only when every key was re-read and differs. */
export function allChanged(rows: VerifyRow[]): boolean {
  return rows.length > 0 && rows.every((r) => r.outcome === "changed");
}

function keyListMismatch(snapshot: Snapshot, names: string[]): string | null {
  const had = new Set(snapshot.keys.map((k) => k.name));
  const want = new Set(names);
  const added = names.filter((n) => !had.has(n));
  const removed = [...had].filter((n) => !want.has(n));
  if (added.length === 0 && removed.length === 0) return null;
  const parts = [
    added.length ? `added since snapshot: ${added.join(", ")}` : "",
    removed.length ? `no longer declared: ${removed.join(", ")}` : "",
  ].filter(Boolean);
  return `key list differs from the snapshot (${parts.join("; ")})`;
}

function shapeProblem(data: unknown, backend: string): string | null {
  const s = data as Partial<Snapshot> | null;
  if (!s || typeof s !== "object") return "not a JSON object";
  if (s.kind !== SNAPSHOT_KIND || s.version !== SNAPSHOT_VERSION) return "unknown snapshot format";
  if (s.backend !== backend) return `snapshot is for backend "${String(s.backend)}"`;
  if (typeof s.hmacKey !== "string" || Buffer.from(s.hmacKey, "base64").length !== 32) {
    return "snapshot key is missing or malformed";
  }
  if (!Array.isArray(s.keys)) return "snapshot has no key list";
  const bad = s.keys.some(
    (k) =>
      !k ||
      typeof k.name !== "string" ||
      !(k.fingerprint === null || /^[0-9a-f]{64}$/.test(String(k.fingerprint))),
  );
  return bad ? "snapshot key entries are malformed" : null;
}

/**
 * Owner-only, a regular file, not a symlink. On POSIX that is stricter than
 * `privateFileIsControlled` (which allows group/other READ): fingerprints plus their key let a
 * reader test guesses, so no other user may read the file. On Windows the ACL check decides.
 */
export function snapshotIsOwnerOnly(path: string): boolean {
  try {
    const st = lstatSync(path, { bigint: true });
    if (!st.isFile()) return false;
    if (process.platform !== "win32" && (st.mode & 0o077n) !== 0n) return false;
    return privateFileIsControlled(path);
  } catch {
    return false;
  }
}

/**
 * Load and check a snapshot. Every failure is a reason, never a fallback: the caller refuses.
 * The permission check runs before the read, so a widened file is not trusted even once.
 */
export async function loadSnapshot(
  path: string,
  backend: string,
  names: string[],
): Promise<LoadResult> {
  if (!existsSync(path)) return { ok: false, reason: "no snapshot on file" };
  if (!snapshotIsOwnerOnly(path)) {
    return { ok: false, reason: "snapshot file is not owner-only (permissions widened)" };
  }
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { ok: false, reason: "snapshot file is unreadable or not valid JSON" };
  }
  const shape = shapeProblem(data, backend);
  if (shape) return { ok: false, reason: shape };
  const snapshot = data as Snapshot;
  const mismatch = keyListMismatch(snapshot, names);
  return mismatch ? { ok: false, reason: mismatch } : { ok: true, snapshot };
}

/**
 * Is `path` ignored by git in `cwd`? `true` outside a git work tree (nothing to commit it to).
 * Uses `git check-ignore --no-index` so an already-tracked path is judged by the rules alone.
 */
export async function isGitIgnored(cwd: string, path: string): Promise<boolean> {
  const inside = await execFileNoThrow("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    timeout: 5_000,
  });
  if (!inside.ok || inside.stdout.trim() !== "true") return true;
  const rel = relative(cwd, path).split("\\").join("/");
  const r = await execFileNoThrow("git", ["check-ignore", "-q", "--no-index", "--", rel], {
    cwd,
    timeout: 5_000,
  });
  return r.ok;
}

/**
 * Write the snapshot owner-only. The temp file is restricted before it is renamed into place, so
 * the fingerprints are never readable by others, not even briefly.
 */
export async function writeSnapshot(path: string, snapshot: Snapshot): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  secureDirStrict(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await secureFileStrictAsync(tmp);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
