/**
 * `kit services`: who runs which local service, checked against what actually runs.
 *
 *   kit services add <name> --kind <k> --ref <r> [--purpose ..] [--ttl 4h] [--project <dir>]
 *   kit services ls [--json]
 *   kit services renew <name> [--ttl ..]
 *   kit services stop <name> [--force]
 *   kit services prune
 *   kit services ask <name> [--message ..]
 *   kit services keep <name> [--ttl ..]
 *   kit services release <name>
 *
 * The lease is the whole safety model. While it runs, only the owner stops the service (or someone
 * with --force). Anyone else asks, and the owner answers with keep or release on its next prompt.
 * When the lease ends unanswered, the service is fair game. No agent-to-agent messaging API is
 * involved: the request is a field in the registry, so it works the same for Claude Code, Codex
 * and a person in a terminal.
 */

import { resolve } from "node:path";
import { getCurrentProjectRoot } from "../memory/project.js";
import { c } from "../utils/colors.js";
import { flagValue, hasFlag, rejectUnknownFlags, GLOBAL_FLAGS } from "../utils/flags.js";
import {
  DEFAULT_TTL,
  SERVICE_KINDS,
  findEntry,
  leaseActive,
  mutateRegistry,
  parseTtl,
  readRegistry,
  servicesFile,
  validName,
  validateRef,
  type ServiceEntry,
  type ServiceKind,
  type ServiceOwner,
} from "../services/registry.js";
import { describeOwner, detectOwner, sameOwner } from "../services/owner.js";
import {
  defaultProbeDeps,
  dockerSnapshot,
  probeEntry,
  stopEntry,
  unregisteredGroups,
  type DockerSnapshot,
  type Liveness,
  type ProbeDeps,
} from "../services/probe.js";

const USAGE = `Usage: kit services <subcommand>

  add <name> --kind <${SERVICE_KINDS.join("|")}> --ref <ref> [--purpose <text>] [--ttl ${DEFAULT_TTL}] [--project <dir>] [--owner <label>]
  ls [--json]                   registry merged with live probes, plus unregistered docker workloads
  renew <name> [--ttl ${DEFAULT_TTL}]       extend your lease
  stop <name> [--force]         stop it, verify it is gone, drop the entry
  prune                         drop entries whose service is no longer running
  ask <name> [--message <text>] ask the owner to stop it
  keep <name> [--ttl ${DEFAULT_TTL}]        (owner) answer a request: still needed, renew
  release <name>                (owner) answer a request: stop it now

Refs: supabase = project_id, compose = compose project name, container = container name,
pid = process id, port = TCP port on localhost. TTL: 30m, 4h, 2d (default ${DEFAULT_TTL}).
Owner: detected from CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID; --owner adds a label.`;

const VALUE_FLAGS = ["--kind", "--ref", "--purpose", "--ttl", "--project", "--owner", "--message"];
const FLAGS = [...VALUE_FLAGS, "--json", "--force", ...GLOBAL_FLAGS];

export interface ServicesDeps {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  now: () => number;
  probe: ProbeDeps;
  file: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

function defaultDeps(): ServicesDeps {
  return {
    argv: process.argv,
    env: process.env,
    cwd: process.cwd(),
    now: Date.now,
    probe: defaultProbeDeps(),
    file: servicesFile(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  };
}

/** Positional args after `kit services`, skipping flags and the values of value flags. */
function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  const rest = argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t === "--") break;
    if (t.startsWith("--")) {
      if (VALUE_FLAGS.includes(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

export type ServiceStatus = "running" | "dead" | "expired" | "unknown";

export function statusOf(entry: ServiceEntry, live: Liveness, now: number): ServiceStatus {
  if (live === "dead") return "dead";
  if (!leaseActive(entry, now)) return "expired";
  return live === "alive" ? "running" : "unknown";
}

export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(abs / 3_600_000);
  if (h < 48) return `${h}h`;
  return `${Math.round(abs / 86_400_000)}d`;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "-";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  return `${Math.round(bytes / 1024 ** 2)}M`;
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd(),
  );
}

function leaseCell(entry: ServiceEntry, now: number): string {
  const left = Date.parse(entry.leaseUntil) - now;
  if (!Number.isFinite(left)) return "invalid lease";
  return left > 0 ? `${formatDuration(left)} left` : `ended ${formatDuration(left)} ago`;
}

function ownerCell(entry: ServiceEntry): string {
  return `${describeOwner(entry.owner)}${entry.ownerEndedAt ? " (session ended)" : ""}`;
}

function refuseNotOwner(d: ServicesDeps, entry: ServiceEntry, verb: string): false {
  d.err(
    `${c.red}refused:${c.reset} "${entry.name}" belongs to ${ownerCell(entry)}${entry.purpose ? ` (${entry.purpose})` : ""}, and its lease runs until ${entry.leaseUntil}.`,
  );
  d.err(
    `Ask the owner: kit services ask ${entry.name} --message "<why>". When the lease ends unanswered, anyone may ${verb} it. --force overrides.`,
  );
  return false;
}

function caller(d: ServicesDeps): ServiceOwner {
  return detectOwner(d.env, flagValue(d.argv, "--owner"));
}

function missing(d: ServicesDeps, name: string | undefined): false {
  if (!name) d.err(`${c.red}missing <name>${c.reset}\n${USAGE}`);
  else d.err(`${c.red}no service named "${name}"${c.reset} (see kit services ls)`);
  return false;
}

async function cmdAdd(d: ServicesDeps, name: string | undefined): Promise<boolean> {
  if (!name) return missing(d, name);
  if (!validName(name)) {
    d.err(`${c.red}invalid name "${name}"${c.reset}: letters, digits, '.', '_', '-' (max 64)`);
    return false;
  }
  const kind = flagValue(d.argv, "--kind");
  const ref = flagValue(d.argv, "--ref");
  if (!kind || !(SERVICE_KINDS as readonly string[]).includes(kind)) {
    d.err(`${c.red}--kind must be one of ${SERVICE_KINDS.join(", ")}${c.reset}`);
    return false;
  }
  if (!ref) {
    d.err(`${c.red}--ref is required${c.reset}`);
    return false;
  }
  const refError = validateRef(kind as ServiceKind, ref);
  if (refError) {
    d.err(`${c.red}${refError}${c.reset}`);
    return false;
  }
  const ttl = parseTtl(flagValue(d.argv, "--ttl"));
  if (ttl === null) {
    d.err(`${c.red}--ttl must look like 30m, 4h or 2d (max 30d)${c.reset}`);
    return false;
  }
  const now = d.now();
  const owner = caller(d);
  const projectFlag = flagValue(d.argv, "--project");
  const entry: ServiceEntry = {
    name,
    kind: kind as ServiceKind,
    ref,
    project: projectFlag ? resolve(d.cwd, projectFlag) : getCurrentProjectRoot(d.cwd),
    owner,
    startedAt: new Date(now).toISOString(),
    leaseUntil: new Date(now + ttl).toISOString(),
  };
  const purpose = flagValue(d.argv, "--purpose");
  if (purpose) entry.purpose = purpose;

  const clash = mutateRegistry((reg) => {
    const existing = findEntry(reg, name);
    if (existing) return { result: existing, write: false };
    reg.services.push(entry);
    return { result: undefined };
  }, d.file);
  if (clash) {
    d.err(
      `${c.red}"${name}" is already registered${c.reset} by ${ownerCell(clash)} (${clash.kind} ${clash.ref}). Use kit services renew ${name}, or pick another name.`,
    );
    return false;
  }
  d.out(
    `${c.green}registered${c.reset} ${name} (${entry.kind} ${entry.ref}) for ${describeOwner(owner)}, lease until ${entry.leaseUntil}`,
  );
  if (owner.agent === "unknown" && !owner.label) {
    d.out(
      `${c.dim}no agent session detected and no --owner given: any other unlabelled terminal counts as the owner${c.reset}`,
    );
  }
  const snap = entry.kind === "pid" || entry.kind === "port" ? null : await dockerSnapshot(d.probe);
  const live = await probeEntry(entry, snap ?? { available: false, reason: "" }, d.probe);
  if (live === "dead") {
    d.out(
      `${c.yellow}note:${c.reset} nothing matching it runs yet. ls shows it as dead until it does.`,
    );
  } else if (live === "unknown" && snap && !snap.available) {
    d.out(
      `${c.yellow}note:${c.reset} docker is not reachable (${snap.reason}), so it was not checked.`,
    );
  }
  return true;
}

interface LsRow {
  entry: ServiceEntry;
  live: Liveness;
  status: ServiceStatus;
}

async function collect(d: ServicesDeps, stats: boolean) {
  const entries = readRegistry(d.file).services;
  const needDocker = stats || entries.some((e) => e.kind !== "pid" && e.kind !== "port");
  const snap: DockerSnapshot = needDocker
    ? await dockerSnapshot(d.probe, { stats })
    : { available: false, reason: "not needed" };
  const now = d.now();
  const rows: LsRow[] = [];
  for (const entry of entries) {
    const live = await probeEntry(entry, snap, d.probe);
    rows.push({ entry, live, status: statusOf(entry, live, now) });
  }
  return { rows, snap, now, unregistered: unregisteredGroups(entries, snap) };
}

async function cmdLs(d: ServicesDeps): Promise<boolean> {
  const { rows, snap, now, unregistered } = await collect(d, true);
  if (hasFlag(d.argv, "--json")) {
    d.out(
      JSON.stringify(
        {
          file: d.file,
          docker: snap.available ? { available: true } : { available: false, reason: snap.reason },
          services: rows.map((r) => ({ ...r.entry, status: r.status, live: r.live })),
          unregistered: unregistered.map((g) => ({
            ...g,
            oldest: g.oldest !== undefined ? new Date(g.oldest).toISOString() : undefined,
          })),
        },
        null,
        2,
      ),
    );
    return true;
  }
  if (rows.length === 0) d.out(`${c.dim}no registered services (${d.file})${c.reset}`);
  else {
    const header = ["NAME", "KIND", "REF", "STATUS", "OWNER", "LEASE", "PURPOSE"];
    const body = rows.map((r) => [
      r.entry.name,
      r.entry.kind,
      r.entry.ref,
      r.status + (r.entry.stopRequest ? " (stop requested)" : ""),
      ownerCell(r.entry),
      leaseCell(r.entry, now),
      r.entry.purpose ?? "",
    ]);
    for (const line of table([header, ...body])) d.out(line);
  }
  if (!snap.available) {
    if (snap.reason !== "not needed") {
      d.out(
        `${c.yellow}docker not reachable:${c.reset} ${snap.reason} (docker entries show unknown)`,
      );
    }
    return true;
  }
  if (unregistered.length > 0) {
    d.out("");
    d.out(`${c.bold}Unregistered docker workloads (unknown owner)${c.reset}`);
    const header = ["KIND", "REF", "CONTAINERS", "AGE", "MEMORY"];
    const body = unregistered.map((g) => [
      g.kind,
      g.ref,
      String(g.containers),
      g.oldest !== undefined ? formatDuration(now - g.oldest) : "-",
      formatBytes(g.memBytes),
    ]);
    for (const line of table([header, ...body])) d.out(line);
    d.out(
      `${c.dim}Claim one with kit services add <name> --kind <kind> --ref <ref>, then renew or stop it.${c.reset}`,
    );
  }
  return true;
}

async function cmdRenew(
  d: ServicesDeps,
  name: string | undefined,
  clear: boolean,
): Promise<boolean> {
  if (!name) return missing(d, name);
  const ttl = parseTtl(flagValue(d.argv, "--ttl"));
  if (ttl === null) {
    d.err(`${c.red}--ttl must look like 30m, 4h or 2d (max 30d)${c.reset}`);
    return false;
  }
  const me = caller(d);
  const force = hasFlag(d.argv, "--force");
  const now = d.now();
  const res = mutateRegistry<{ entry?: ServiceEntry; refused?: boolean }>((reg) => {
    const entry = findEntry(reg, name);
    if (!entry) return { result: {}, write: false };
    if (!sameOwner(entry.owner, me) && !force)
      return { result: { entry, refused: true }, write: false };
    entry.leaseUntil = new Date(now + ttl).toISOString();
    if (clear) delete entry.stopRequest;
    return { result: { entry } };
  }, d.file);
  if (!res.entry) return missing(d, name);
  if (res.refused) {
    d.err(
      `${c.red}refused:${c.reset} only the owner (${ownerCell(res.entry)}) can ${clear ? "keep" : "renew"} "${name}". --force overrides.`,
    );
    return false;
  }
  d.out(
    `${c.green}${clear ? "kept" : "renewed"}${c.reset} ${name}: lease until ${res.entry.leaseUntil}${clear ? ", stop request cleared" : ""}`,
  );
  return true;
}

async function cmdStop(
  d: ServicesDeps,
  name: string | undefined,
  ownerOnly: boolean,
): Promise<boolean> {
  if (!name) return missing(d, name);
  const entry = findEntry(readRegistry(d.file), name);
  if (!entry) return missing(d, name);
  const me = caller(d);
  const force = hasFlag(d.argv, "--force");
  const now = d.now();
  const isOwner = sameOwner(entry.owner, me);
  if (ownerOnly && !isOwner && !force) {
    d.err(`${c.red}refused:${c.reset} only the owner (${ownerCell(entry)}) can release "${name}".`);
    return false;
  }
  if (!isOwner && !force) {
    if (leaseActive(entry, now)) return refuseNotOwner(d, entry, "stop");
    if (entry.kind === "pid") {
      d.err(
        `${c.red}refused:${c.reset} the OS reuses process ids, so pid ${entry.ref} may no longer be the process ${ownerCell(entry)} registered. Check it, then pass --force.`,
      );
      return false;
    }
  }
  if (entry.kind === "port") {
    const outcome = await stopEntry(entry, d.probe);
    d.err(`${c.red}${outcome.detail}${c.reset}`);
    return false;
  }
  const needsDocker = entry.kind !== "pid";
  const before = needsDocker
    ? await dockerSnapshot(d.probe)
    : { available: false as const, reason: "" };
  if (needsDocker && !before.available) {
    d.err(`${c.red}docker is not reachable:${c.reset} ${before.reason}. Nothing was stopped.`);
    return false;
  }
  if ((await probeEntry(entry, before, d.probe)) === "dead") {
    removeEntry(d, name);
    d.out(`${name} was not running; removed it from the registry.`);
    return true;
  }
  const outcome = await stopEntry(entry, d.probe);
  if (!outcome.ok) {
    d.err(`${c.red}stop failed:${c.reset} ${outcome.detail}. The entry is kept.`);
    return false;
  }
  const after = needsDocker ? await dockerSnapshot(d.probe) : before;
  const live = await probeEntry(entry, after, d.probe);
  if (live !== "dead") {
    d.err(
      `${c.red}ran ${outcome.detail}, but ${name} still ${live === "alive" ? "runs" : "cannot be checked"}.${c.reset} The entry is kept.`,
    );
    return false;
  }
  removeEntry(d, name);
  d.out(`${c.green}stopped${c.reset} ${name} (${outcome.detail}); verified gone, entry removed.`);
  return true;
}

function removeEntry(d: ServicesDeps, name: string): void {
  mutateRegistry((reg) => {
    const before = reg.services.length;
    reg.services = reg.services.filter((e) => e.name !== name);
    return { result: undefined, write: reg.services.length !== before };
  }, d.file);
}

async function cmdPrune(d: ServicesDeps): Promise<boolean> {
  const { rows } = await collect(d, false);
  const dead = new Set(rows.filter((r) => r.live === "dead").map((r) => r.entry.name));
  if (dead.size === 0) {
    d.out("nothing to prune: every entry is running or could not be checked.");
    return true;
  }
  mutateRegistry((reg) => {
    reg.services = reg.services.filter((e) => !dead.has(e.name));
    return { result: undefined };
  }, d.file);
  d.out(
    `${c.green}pruned${c.reset} ${dead.size} dead entr${dead.size === 1 ? "y" : "ies"}: ${[...dead].join(", ")}`,
  );
  return true;
}

async function cmdAsk(d: ServicesDeps, name: string | undefined): Promise<boolean> {
  if (!name) return missing(d, name);
  const me = caller(d);
  const now = d.now();
  const message = flagValue(d.argv, "--message");
  const entry = mutateRegistry<ServiceEntry | undefined>((reg) => {
    const e = findEntry(reg, name);
    if (!e) return { result: undefined, write: false };
    e.stopRequest = { by: me, at: new Date(now).toISOString(), ...(message ? { message } : {}) };
    return { result: e };
  }, d.file);
  if (!entry) return missing(d, name);
  d.out(`${c.green}asked${c.reset} ${ownerCell(entry)} to stop "${name}".`);
  if (leaseActive(entry, now)) {
    d.out(
      `The owner sees the request on its next prompt and answers with keep or release. If it does not answer, the lease ends at ${entry.leaseUntil} and you may stop it then.`,
    );
  } else {
    d.out(`The lease already ended, so you may stop it now: kit services stop ${name}`);
  }
  return true;
}

export async function runServices(d: ServicesDeps): Promise<boolean> {
  const [sub = "ls", name] = positionals(d.argv);
  if (rejectUnknownFlags(`kit services ${sub}`, FLAGS, d.argv, d.err)) return false;
  try {
    switch (sub) {
      case "add":
        return await cmdAdd(d, name);
      case "ls":
      case "list":
        return await cmdLs(d);
      case "renew":
        return await cmdRenew(d, name, false);
      case "keep":
        return await cmdRenew(d, name, true);
      case "stop":
        return await cmdStop(d, name, false);
      case "release":
        return await cmdStop(d, name, true);
      case "prune":
        return await cmdPrune(d);
      case "ask":
        return await cmdAsk(d, name);
      default:
        d.err(`${c.red}unknown subcommand: ${sub}${c.reset}`);
        d.err(USAGE);
        return false;
    }
  } catch (err) {
    d.err(`${c.red}kit services ${sub}: ${(err as Error).message}${c.reset}`);
    return false;
  }
}

export async function cmdServices(): Promise<boolean> {
  return runServices(defaultDeps());
}
