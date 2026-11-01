/**
 * `kit services` registry: a per-user index of the local services agents start.
 *
 * WHY. Agent sessions (Claude Code, Codex) start containers, Supabase stacks and dev servers and
 * then end without stopping them. Weeks later nobody can tell who owns a container or whether it is
 * still needed. The registry records who started what, for which project, and until when (the
 * lease). An entry whose lease has ended is safe for anyone to stop.
 *
 * STORAGE. One JSON file under the per-user kit state dir (`~/.kit/services.json`, override with
 * `KIT_SERVICES_FILE`). Every write takes an exclusive lock file, re-reads, applies the change and
 * publishes it with temp file + rename, so two agents that register at the same moment cannot
 * drop each other's entry. Readers never take the lock: a rename is atomic, so a reader sees the
 * old file or the new file, never half of one.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_KINDS = ["supabase", "compose", "container", "pid", "port"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export type AgentKind = "claude" | "codex" | "unknown";

export interface ServiceOwner {
  agent: AgentKind;
  /** Harness session id when the environment exposes one. */
  session?: string;
  /** Free-form name from `--owner` (a person, or an agent without a session id). */
  label?: string;
}

export interface StopRequest {
  by: ServiceOwner;
  at: string;
  message?: string;
}

export interface ServiceEntry {
  name: string;
  kind: ServiceKind;
  ref: string;
  project: string;
  owner: ServiceOwner;
  purpose?: string;
  startedAt: string;
  leaseUntil: string;
  stopRequest?: StopRequest;
  /** Set by the SessionEnd hook when the owning session ended; cleared when it resumes. */
  ownerEndedAt?: string;
}

export interface ServiceRegistry {
  version: 1;
  services: ServiceEntry[];
}

export function servicesFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KIT_SERVICES_FILE;
  if (override && override.length > 0) return override;
  return join(homedir(), ".kit", "services.json");
}

export function emptyRegistry(): ServiceRegistry {
  return { version: 1, services: [] };
}

function isEntry(value: unknown): value is ServiceEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.name === "string" &&
    typeof e.kind === "string" &&
    (SERVICE_KINDS as readonly string[]).includes(e.kind) &&
    typeof e.ref === "string" &&
    typeof e.project === "string" &&
    typeof e.startedAt === "string" &&
    typeof e.leaseUntil === "string" &&
    !!e.owner &&
    typeof e.owner === "object"
  );
}

/**
 * Read the registry. A missing file is an empty registry. A corrupt file throws: silently
 * treating it as empty would let the next write erase every entry.
 */
export function readRegistry(path: string = servicesFile()): ServiceRegistry {
  if (!existsSync(path)) return emptyRegistry();
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return emptyRegistry();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`services registry is not valid JSON: ${path}`);
  }
  const services = (parsed as { services?: unknown }).services;
  if (!Array.isArray(services)) throw new Error(`services registry has no services array: ${path}`);
  return { version: 1, services: services.filter(isEntry) };
}

const LOCK_TIMEOUT_MS = 10_000;
/** A lock older than this is from a crashed writer: a real write holds it for milliseconds. */
const STALE_LOCK_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath: string): number {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      return fd;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Windows reports EPERM while another process is deleting the lock file.
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw err;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
        unlinkSync(lockPath);
        continue;
      }
    } catch {
      // The holder released it between our open and stat: retry at once.
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`services registry is locked by another kit process: ${lockPath}`);
    }
    sleepSync(delay + Math.floor(Math.random() * delay));
    delay = Math.min(delay * 2, 100);
  }
}

function releaseLock(lockPath: string, fd: number): void {
  try {
    closeSync(fd);
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/** Publish the file with temp file + rename. Windows can refuse a rename while a reader has the
 *  target open, so retry briefly on the codes it uses for that. */
function writeAtomic(path: string, content: string): void {
  const tmp = join(dirname(path), `.services.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(25);
    }
  }
}

/**
 * Apply `change` to the registry under the lock and write the result. `change` mutates the
 * registry in place and returns a value for the caller. When it returns with `write: false`
 * nothing is written (a no-op hook must not churn the file).
 */
export function mutateRegistry<T>(
  change: (registry: ServiceRegistry) => { result: T; write?: boolean },
  path: string = servicesFile(),
): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const fd = acquireLock(lockPath);
  try {
    const registry = readRegistry(path);
    const { result, write = true } = change(registry);
    if (write) writeAtomic(path, `${JSON.stringify(registry, null, 2)}\n`);
    return result;
  } finally {
    releaseLock(lockPath, fd);
  }
}

export function findEntry(registry: ServiceRegistry, name: string): ServiceEntry | undefined {
  return registry.services.find((e) => e.name === name);
}

export function leaseActive(entry: ServiceEntry, now: number = Date.now()): boolean {
  const until = Date.parse(entry.leaseUntil);
  return Number.isFinite(until) && until > now;
}

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_TTL = "4h";

/** Parse `30m`, `4h`, `2d` into milliseconds. Returns null for anything else. */
export function parseTtl(text: string | undefined): number | null {
  if (text === undefined) return DEFAULT_TTL_MS;
  const m = /^(\d+)(m|h|d)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  const ms = n * unit;
  if (ms <= 0 || ms > MAX_TTL_MS) return null;
  return ms;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DOCKER_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function validName(name: string): boolean {
  return NAME_RE.test(name);
}

/**
 * Refs end up as arguments to docker / supabase / taskkill. They are passed as argv, never
 * through a shell, except the Windows `supabase` shim; validating them here keeps that one shell
 * call safe and catches typos early.
 */
export function validateRef(kind: ServiceKind, ref: string): string | null {
  if (kind === "pid") {
    return /^[1-9]\d{0,9}$/.test(ref) ? null : "pid ref must be a positive integer";
  }
  if (kind === "port") {
    const n = Number(ref);
    return /^\d{1,5}$/.test(ref) && n >= 1 && n <= 65535 ? null : "port ref must be 1-65535";
  }
  return DOCKER_REF_RE.test(ref)
    ? null
    : `${kind} ref may contain only letters, digits, '.', '_' and '-'`;
}
