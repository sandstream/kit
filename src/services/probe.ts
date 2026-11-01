/**
 * Live probes for `kit services`: is a registered service still running, what runs that nobody
 * registered, and how to stop each kind.
 *
 * Docker is read with ONE `docker ps` call per command, so `ls` costs the same with 3 entries or
 * 40. When docker is missing or its daemon is down, every docker-backed entry reads `unknown`,
 * never `dead`: a probe that cannot see must not make an entry look safe to prune.
 *
 * Everything that touches a process goes through a {@link ProbeDeps} object, so tests drive the
 * whole merge with fixed docker output and no docker on the CI host.
 */

import { connect } from "node:net";
import { execFileNoThrow, type ExecResult } from "../utils/execFileNoThrow.js";
import type { ServiceEntry } from "./registry.js";

export const SUPABASE_LABEL = "com.supabase.cli.project";
export const COMPOSE_LABEL = "com.docker.compose.project";

export interface DockerContainer {
  id: string;
  name: string;
  supabase?: string;
  compose?: string;
  /** epoch ms, when docker reported a parseable CreatedAt. */
  createdAt?: number;
  /** bytes, from `docker stats`, when collected. */
  memBytes?: number;
}

export type DockerSnapshot =
  | { available: true; containers: DockerContainer[] }
  | { available: false; reason: string };

export type Liveness = "alive" | "dead" | "unknown";

export interface RunOptions {
  timeout?: number;
  cwd?: string;
  shell?: boolean;
}

export interface ProbeDeps {
  run: (cmd: string, args: string[], opts?: RunOptions) => Promise<ExecResult>;
  pidAlive: (pid: number) => boolean;
  portOpen: (port: number) => Promise<boolean>;
  platform: NodeJS.Platform;
}

async function defaultRun(cmd: string, args: string[], opts: RunOptions = {}): Promise<ExecResult> {
  if (!opts.shell) return execFileNoThrow(cmd, args, { timeout: opts.timeout, cwd: opts.cwd });
  // Only the Windows `supabase` npm shim (a .cmd file) needs a shell: Node refuses to execFile a
  // .cmd without one. Every argument was validated by validateRef, so nothing here is quoted.
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeout ?? 120_000, cwd: opts.cwd, shell: true },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: code, ok: !error });
      },
    );
  });
}

export function pidAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function portOpenDefault(port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function defaultProbeDeps(): ProbeDeps {
  return {
    run: defaultRun,
    pidAlive: pidAliveDefault,
    portOpen: portOpenDefault,
    platform: process.platform,
  };
}

const PS_FORMAT = `{{.ID}}\t{{.Names}}\t{{.Label "${SUPABASE_LABEL}"}}\t{{.Label "${COMPOSE_LABEL}"}}\t{{.CreatedAt}}`;

/** `2026-06-10 12:34:56 +0200 CEST` → epoch ms. */
export function parseDockerTime(text: string): number | undefined {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(?:\.\d+)? ([+-]\d\d)(\d\d)/.exec(text.trim());
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isFinite(t) ? t : undefined;
}

export function parsePsOutput(stdout: string): DockerContainer[] {
  const out: DockerContainer[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [id = "", names = "", supabase = "", compose = "", created = ""] = line.split("\t");
    const c: DockerContainer = { id: id.trim(), name: names.split(",")[0]!.trim() };
    if (supabase.trim()) c.supabase = supabase.trim();
    if (compose.trim()) c.compose = compose.trim();
    const t = parseDockerTime(created);
    if (t !== undefined) c.createdAt = t;
    out.push(c);
  }
  return out;
}

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

/** `512.3MiB / 7.6GiB` → bytes of the used part. */
export function parseMemUsage(text: string): number | undefined {
  const m = /^\s*([\d.]+)\s*([KMGT]?i?B)/i.exec(text);
  if (!m) return undefined;
  const unit = UNITS[m[2]!.toUpperCase()];
  if (unit === undefined) return undefined;
  return Math.round(Number(m[1]) * unit);
}

/** One `docker ps` (and optionally one `docker stats`) for the whole command. */
export async function dockerSnapshot(
  deps: ProbeDeps,
  opts: { stats?: boolean } = {},
): Promise<DockerSnapshot> {
  const ps = await deps.run("docker", ["ps", "--no-trunc", "--format", PS_FORMAT], {
    timeout: 15_000,
  });
  if (!ps.ok) {
    const reason = (ps.stderr || ps.stdout).trim().split(/\r?\n/)[0] || "docker is not available";
    return { available: false, reason };
  }
  const containers = parsePsOutput(ps.stdout);
  if (opts.stats && containers.length > 0) {
    const stats = await deps.run(
      "docker",
      ["stats", "--no-stream", "--no-trunc", "--format", "{{.ID}}\t{{.MemUsage}}"],
      { timeout: 30_000 },
    );
    if (stats.ok) {
      const mem = new Map<string, number>();
      for (const line of stats.stdout.split(/\r?\n/)) {
        const [id = "", usage = ""] = line.split("\t");
        const bytes = parseMemUsage(usage);
        if (id.trim() && bytes !== undefined) mem.set(id.trim(), bytes);
      }
      for (const c of containers) {
        const bytes = mem.get(c.id) ?? [...mem].find(([id]) => c.id.startsWith(id))?.[1];
        if (bytes !== undefined) c.memBytes = bytes;
      }
    }
  }
  return { available: true, containers };
}

/** Containers that belong to a docker-backed entry. Empty for pid and port entries. */
export function containersFor(entry: ServiceEntry, snap: DockerSnapshot): DockerContainer[] {
  if (!snap.available) return [];
  switch (entry.kind) {
    case "supabase":
      return snap.containers.filter((c) => c.supabase === entry.ref);
    case "compose":
      return snap.containers.filter((c) => c.compose === entry.ref);
    case "container":
      return snap.containers.filter(
        (c) => c.name === entry.ref || (entry.ref.length >= 12 && c.id.startsWith(entry.ref)),
      );
    default:
      return [];
  }
}

export async function probeEntry(
  entry: ServiceEntry,
  snap: DockerSnapshot,
  deps: ProbeDeps,
): Promise<Liveness> {
  if (entry.kind === "pid") return deps.pidAlive(Number(entry.ref)) ? "alive" : "dead";
  if (entry.kind === "port") return (await deps.portOpen(Number(entry.ref))) ? "alive" : "dead";
  if (!snap.available) return "unknown";
  return containersFor(entry, snap).length > 0 ? "alive" : "dead";
}

export interface UnregisteredGroup {
  kind: "supabase" | "compose" | "container";
  ref: string;
  containers: number;
  /** epoch ms of the oldest container in the group. */
  oldest?: number;
  memBytes?: number;
}

/** Running docker workloads no registry entry claims, grouped by Supabase or compose label. */
export function unregisteredGroups(
  entries: readonly ServiceEntry[],
  snap: DockerSnapshot,
): UnregisteredGroup[] {
  if (!snap.available) return [];
  const claimed = new Set<string>();
  for (const e of entries) for (const c of containersFor(e, snap)) claimed.add(c.id);
  const groups = new Map<string, UnregisteredGroup>();
  for (const c of snap.containers) {
    if (claimed.has(c.id)) continue;
    const kind: UnregisteredGroup["kind"] = c.supabase
      ? "supabase"
      : c.compose
        ? "compose"
        : "container";
    const ref = c.supabase ?? c.compose ?? c.name;
    const key = `${kind}\0${ref}`;
    const g = groups.get(key) ?? { kind, ref, containers: 0 };
    g.containers++;
    if (c.createdAt !== undefined) g.oldest = Math.min(g.oldest ?? c.createdAt, c.createdAt);
    if (c.memBytes !== undefined) g.memBytes = (g.memBytes ?? 0) + c.memBytes;
    groups.set(key, g);
  }
  return [...groups.values()].sort(
    (a, b) => (b.memBytes ?? 0) - (a.memBytes ?? 0) || a.ref.localeCompare(b.ref),
  );
}

export interface StopOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Stop one entry. Supabase keeps its volumes (`supabase stop` without `--no-backup`), compose runs
 * `down` (volumes kept unless the compose file says otherwise), a lone container is removed, a pid
 * is terminated. A port has no owner process kit can name, so it is refused.
 */
export async function stopEntry(entry: ServiceEntry, deps: ProbeDeps): Promise<StopOutcome> {
  const fail = (r: ExecResult, what: string): StopOutcome => ({
    ok: false,
    detail: `${what} failed: ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" ")}`,
  });
  switch (entry.kind) {
    case "supabase": {
      const r = await deps.run("supabase", ["stop", "--project-id", entry.ref], {
        timeout: 180_000,
        shell: deps.platform === "win32",
      });
      return r.ok ? { ok: true, detail: "supabase stop" } : fail(r, "supabase stop");
    }
    case "compose": {
      const r = await deps.run("docker", ["compose", "-p", entry.ref, "down"], {
        timeout: 180_000,
      });
      return r.ok ? { ok: true, detail: "docker compose down" } : fail(r, "docker compose down");
    }
    case "container": {
      const r = await deps.run("docker", ["rm", "-f", entry.ref], { timeout: 60_000 });
      return r.ok ? { ok: true, detail: "docker rm -f" } : fail(r, "docker rm -f");
    }
    case "pid":
      return stopPid(Number(entry.ref), deps);
    case "port":
      return {
        ok: false,
        detail:
          "kit cannot stop a port entry: it does not know which process holds the port. Stop that process yourself, then run `kit services prune`.",
      };
  }
}

/** Send a signal; the error (if any) is returned, not thrown, so the caller decides what it means. */
function sendSignal(pid: number, signal: NodeJS.Signals): NodeJS.ErrnoException | undefined {
  try {
    process.kill(pid, signal);
    return undefined;
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
}

async function stopPid(pid: number, deps: ProbeDeps): Promise<StopOutcome> {
  if (deps.platform === "win32") {
    // process.kill on Windows ends only the one process; a dev server's children would survive.
    const r = await deps.run("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 30_000 });
    return r.ok ? { ok: true, detail: "taskkill /T /F" } : fail(r);
  }
  const termError = sendSignal(pid, "SIGTERM");
  // ESRCH: the process ended before the signal, which is the outcome stop wants.
  if (termError?.code === "ESRCH") return { ok: true, detail: "not running" };
  if (termError) return { ok: false, detail: `SIGTERM failed: ${termError.message}` };
  for (let i = 0; i < 50; i++) {
    if (!deps.pidAlive(pid)) return { ok: true, detail: "SIGTERM" };
    await new Promise((r) => setTimeout(r, 100));
  }
  // An error here means it ended between the check and the kill; the caller probes again anyway.
  sendSignal(pid, "SIGKILL");
  return { ok: true, detail: "SIGKILL after 5 s" };

  function fail(r: ExecResult): StopOutcome {
    return { ok: false, detail: `taskkill failed: ${(r.stderr || r.stdout).trim()}` };
  }
}
