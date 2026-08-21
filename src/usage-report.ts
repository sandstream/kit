/**
 * What kit is worth, measured from what kit itself recorded.
 *
 * The question this answers is not "how many tokens did you save" — there is no counterfactual
 * for that, and a number without one is invented. It is the reliability question: **what do you
 * know, and do you know it the same way every time?**
 *
 * Without a declared floor, "is this safe?" is answered by whatever subset an agent improvises on
 * the spot. You get a verdict with no denominator, a different subset on the next run, and no
 * record of what was not looked at — so "it looks fine" and "I did not look" are the same
 * sentence. Measured here on kit's own repo: 37 enumerated checks, 21 pass, 4 warn, **12 that
 * could not run, each with its reason**, and two consecutive runs producing an identical verdict
 * set. The twelve are the product as much as the twenty-one are.
 *
 * Every number in this module comes from a file kit already writes:
 *
 *   - `.kit/runs/check-*.json`     the enumerated check results of a real run
 *   - `.kit-audit.jsonl`           every audited operation and refusal
 *   - `.kit-triage.jsonl`          package triage outcomes
 *   - `.kit-skipped-commits.jsonl` commits that bypassed the hook
 *   - `~/.kit/audit-anchor.json`   every repo this machine has sealed a log in
 *   - `.kit/shared/memory.jsonl`   curated team decisions
 *
 * Nothing here calls the network, and nothing here estimates. A field kit did not record is
 * reported as unknown rather than inferred — the rule the rest of this codebase is built on.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

export interface CoverageFacts {
  /** When the run these numbers come from happened, or null when no run is on disk. */
  at: string | null;
  enumerated: number;
  pass: number;
  warn: number;
  fail: number;
  /** Checks that could not run, WITH the reason each gave. This list is the honest part. */
  couldNotRun: Array<{ name: string; reason: string }>;
}

export interface FloorFacts {
  /** Audited operations in this repo's log. */
  events: number;
  /** Operations the floor refused (`success: false`). */
  refusals: number;
  /** Refusal counts per operation, most frequent first. */
  byOperation: Array<[string, number]>;
  /** Commits recorded as having bypassed the hook (`--no-verify`). */
  bypassedCommits: number;
  /**
   * True when the log carries no `cwd` on its entries, so operator activity cannot be told apart
   * from test-generated activity. Reported rather than silently mixed: kit's own repo has 7194
   * events and not one carries a cwd, which would make every per-actor number meaningless.
   */
  actorUnknown: boolean;
}

export interface TriageFacts {
  runs: number;
  byType: Array<[string, number]>;
  latest: { type: string; target: string } | null;
}

export interface MachineFacts {
  /** Repos this machine has sealed an audit log in — the anchor record is that index. */
  sealedRepos: number;
  /** How many of those logs are still on disk (a temp dir that vanished is attrition). */
  liveRepos: number;
  /** Curated shared decisions committed in this repo. */
  sharedEntries: number;
}

export interface MemoryFacts {
  /** The store's path — the proof of ownership: it is a file on your disk, not a tenant row. */
  path: string | null;
  /** Bytes on disk. */
  bytes: number;
  messages: number;
  sessions: number;
  /** Harnesses that have written to it (claude-code, codex, …). */
  harnesses: Array<[string, number]>;
  /** Messages + output tokens per project, biggest first. */
  projects: Array<{ project: string; messages: number; outputTokens: number | null }>;
  /** Output tokens and cache-read tokens over the window, when the rows carry them. */
  outputTokens: number | null;
  cacheReadTokens: number | null;
  /** Days the window covers. */
  windowDays: number;
  /** True when a cross-device sync transport is configured (opt-in, your own transport). */
  syncConfigured: boolean;
}

export interface UsageFacts {
  /** Present only after `--prove`: live negative controls against the floor. */
  proof?: import("./usage-prove.js").ProofResult;
  coverage: CoverageFacts;
  memory: MemoryFacts;
  floor: FloorFacts;
  triage: TriageFacts;
  machine: MachineFacts;
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((x): x is Record<string, unknown> => x !== null);
  } catch {
    return [];
  }
}

/** Pull the enumerated check results out of the most recent saved run. */
export function coverageFromRuns(cwd: string): CoverageFacts {
  const empty: CoverageFacts = {
    at: null,
    enumerated: 0,
    pass: 0,
    warn: 0,
    fail: 0,
    couldNotRun: [],
  };
  const dir = join(cwd, ".kit", "runs");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.startsWith("check-") && f.endsWith(".json"))
      .sort();
  } catch {
    return empty;
  }
  const newest = files[files.length - 1];
  if (!newest) return empty;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(join(dir, newest), "utf-8")) as Record<string, unknown>;
  } catch {
    return empty;
  }

  // The run object groups results per dimension (security, tools, deploy, tests, …); each group
  // is an array of rows carrying a status. Walk them all rather than naming them, so a new
  // dimension counts without this needing to know about it.
  const rows: Array<{ name: string; status: string; detail: string }> = [];
  for (const [group, value] of Object.entries(parsed)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      if (typeof row !== "object" || row === null) continue;
      const r = row as Record<string, unknown>;
      if (typeof r.status !== "string") continue;
      const name = [r.category ?? group, r.name ?? r.provider ?? ""]
        .filter((x) => typeof x === "string" && x.length > 0)
        .join("/");
      rows.push({
        name: name || group,
        status: r.status,
        detail: typeof r.detail === "string" ? r.detail : "",
      });
    }
  }

  const stamp = /check-(\d+)\.json/.exec(newest)?.[1];
  return {
    at: stamp ? new Date(Number(stamp)).toISOString() : null,
    enumerated: rows.length,
    pass: rows.filter((r) => r.status === "pass").length,
    warn: rows.filter((r) => r.status === "warn").length,
    fail: rows.filter((r) => r.status === "fail").length,
    couldNotRun: rows
      .filter((r) => !["pass", "warn", "fail"].includes(r.status))
      .map((r) => ({ name: r.name, reason: r.detail })),
  };
}

export function floorFromLogs(cwd: string): FloorFacts {
  const events = readJsonl(join(cwd, ".kit-audit.jsonl"));
  const refusals = events.filter((e) => e.success === false);
  const counts = new Map<string, number>();
  for (const e of refusals) {
    const op = typeof e.operation === "string" ? e.operation : "(unnamed)";
    counts.set(op, (counts.get(op) ?? 0) + 1);
  }
  return {
    events: events.length,
    refusals: refusals.length,
    byOperation: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    bypassedCommits: readJsonl(join(cwd, ".kit-skipped-commits.jsonl")).length,
    actorUnknown: events.length > 0 && events.every((e) => typeof e.cwd !== "string"),
  };
}

export function triageFromLog(cwd: string): TriageFacts {
  const runs = readJsonl(join(cwd, ".kit-triage.jsonl"));
  const counts = new Map<string, number>();
  for (const r of runs) {
    const t = typeof r.type === "string" ? r.type : "(unknown)";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const last = runs[runs.length - 1];
  return {
    runs: runs.length,
    byType: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    latest:
      last && typeof last.type === "string" && typeof last.target === "string"
        ? { type: last.type, target: last.target }
        : null,
  };
}

export function machineFromAnchor(cwd: string, home = homedir()): MachineFacts {
  let sealed = 0;
  let live = 0;
  try {
    const record = JSON.parse(
      readFileSync(join(home, ".kit", "audit-anchor.json"), "utf-8"),
    ) as Record<string, unknown> | null;
    // Only keys that are log paths count. The record is a flat map of path -> {tip,count,...},
    // and counting every top-level key would turn a future metadata key ("version") into a repo
    // this machine never sealed.
    const paths = record
      ? Object.keys(record).filter((k) => k.startsWith("/") && k.endsWith(".jsonl"))
      : [];
    sealed = paths.length;
    live = paths.filter((p) => existsSync(p)).length;
  } catch {
    /* never anchored here */
  }
  return {
    sealedRepos: sealed,
    liveRepos: live,
    sharedEntries: readJsonl(join(cwd, ".kit", "shared", "memory.jsonl")).length,
  };
}

/**
 * The memory store, read read-only.
 *
 * "We own the memory" is a claim kit can substantiate rather than assert: the store is a SQLite
 * file at a path you can see, sized in bytes you can check, and cross-device sync is opt-in over
 * a transport you supply — there is no cloud ledger to be a tenant of. So this tab reports the
 * path and the size first, and the per-project breakdown second.
 *
 * Aggregates only. A field the rows do not carry (older messages predate token capture) is
 * reported as null rather than zero — zero would read as "nothing spent".
 */
export function memoryFromDb(windowDays = 7): MemoryFacts {
  const empty: MemoryFacts = {
    path: null,
    bytes: 0,
    messages: 0,
    sessions: 0,
    harnesses: [],
    projects: [],
    outputTokens: null,
    cacheReadTokens: null,
    windowDays,
    syncConfigured: false,
  };
  const candidates = [process.env.KIT_MEMORY_DB, join(homedir(), ".kit", "memory.db")].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const path = candidates.find((p) => existsSync(p));
  if (!path) return empty;

  let bytes = 0;
  try {
    bytes = statSync(path).size;
  } catch {
    /* unreadable size is not fatal */
  }

  try {
    // node:sqlite, read-only: this command must never be able to mutate the store it reports on.
    // createRequire rather than a static import: the module is experimental and prints a warning
    // on load, and this whole function must degrade to "unknown" on a runtime that lacks it.
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    const one = (sql: string): Record<string, unknown> =>
      (db.prepare(sql).get() ?? {}) as Record<string, unknown>;
    const all = (sql: string): Array<Record<string, unknown>> =>
      db.prepare(sql).all() as Array<Record<string, unknown>>;
    const since = `datetime('now','-${Math.max(1, Math.floor(windowDays))} days')`;

    const messages = Number(one("SELECT COUNT(*) c FROM messages").c ?? 0);
    const sessions = Number(one("SELECT COUNT(*) c FROM sessions").c ?? 0);
    const tok = one(
      `SELECT SUM(output_tokens) o, SUM(cache_read_input_tokens) cr FROM messages WHERE timestamp >= ${since}`,
    );
    const harnesses = all(
      "SELECT harness h, COUNT(*) n FROM sessions GROUP BY 1 ORDER BY 2 DESC LIMIT 6",
    ).map((r) => [String(r.h ?? "(unknown)"), Number(r.n ?? 0)] as [string, number]);
    const projects = all(
      `SELECT COALESCE(s.project,'(unknown)') p, COUNT(*) n, SUM(m.output_tokens) o
       FROM messages m JOIN sessions s ON s.session_id = m.session_id
       WHERE m.timestamp >= ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`,
    ).map((r) => ({
      project: String(r.p ?? "(unknown)"),
      messages: Number(r.n ?? 0),
      outputTokens: r.o === null || r.o === undefined ? null : Number(r.o),
    }));
    db.close();

    return {
      path,
      bytes,
      messages,
      sessions,
      harnesses,
      projects,
      outputTokens: tok.o === null || tok.o === undefined ? null : Number(tok.o),
      cacheReadTokens: tok.cr === null || tok.cr === undefined ? null : Number(tok.cr),
      windowDays,
      syncConfigured:
        existsSync(join(homedir(), ".kit", "memory-sync.json")) ||
        typeof process.env.KIT_MEMORY_REMOTE === "string",
    };
  } catch {
    return { ...empty, path, bytes };
  }
}

export function gatherUsage(cwd: string = process.cwd(), home = homedir()): UsageFacts {
  return {
    coverage: coverageFromRuns(cwd),
    memory: memoryFromDb(),
    floor: floorFromLogs(cwd),
    triage: triageFromLog(cwd),
    machine: machineFromAnchor(cwd, home),
  };
}
