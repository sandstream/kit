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

export interface StandardsFacts {
  /** When the run these numbers come from happened; null when nothing has been saved. */
  at: string | null;
  standards: Array<{
    key: string;
    label: string;
    version: string;
    total: number;
    /** Controls kit maps to a check of its own. */
    auto: number;
    /** Of those, the ones whose check actually RAN and passed. This is the evidence number. */
    verified: number;
    failing: number;
    unrun: number;
    /** Mapped to a check kit does not have yet. */
    gap: number;
    /** Covered by a human procedure, not by a check. */
    manual: number;
    na: number;
  }>;
}

export interface KeysFacts {
  /** Declared in `[secrets.keys]` — names only; no value is read anywhere in this module. */
  declared: number;
  /** How the declared keys are resolved (env, vault, op, …), most common first. */
  bySource: Array<[string, number]>;
  /** Keys the last run could resolve, and the names it could not. Null when no run is saved. */
  available: number | null;
  missing: string[];
  /**
   * What the history scan found, parsed from the saved run's `secrets scan` row. Null when that row
   * is absent or its wording changed — a number kit cannot read is reported as unknown, not zero.
   */
  history: {
    verifiedLive: number;
    unverified: number;
    examples: number;
    accepted: number;
  } | null;
  /** Whether `.env*` is covered by .gitignore, per the saved run. Null when the row is absent. */
  envIgnored: boolean | null;
}

export interface UsageFacts {
  /** Present only after `--prove`: live negative controls against the floor. */
  proof?: import("./usage-prove.js").ProofResult;
  coverage: CoverageFacts;
  standards: StandardsFacts;
  keys: KeysFacts;
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

/** The security rows of the newest saved run — the evidence every standard is scored against. */
function securityRowsFromRuns(cwd: string): { at: string | null; rows: unknown[] } {
  const dir = join(cwd, ".kit", "runs");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.startsWith("check-") && f.endsWith(".json"))
      .sort();
  } catch {
    return { at: null, rows: [] };
  }
  const newest = files[files.length - 1];
  if (!newest) return { at: null, rows: [] };
  try {
    const parsed = JSON.parse(readFileSync(join(dir, newest), "utf-8")) as Record<string, unknown>;
    const stamp = /check-(\d+)\.json/.exec(newest)?.[1];
    const security = Array.isArray(parsed.security) ? parsed.security : [];
    return { at: stamp ? new Date(Number(stamp)).toISOString() : null, rows: security };
  } catch {
    return { at: null, rows: [] };
  }
}

/**
 * Standards coverage, scored against the last saved run rather than a fresh scan.
 *
 * The distinction that matters to anyone who has to show this to a client is `auto` vs `verified`:
 * a control kit MAPS to a check is a claim, and a control whose check actually ran and passed is
 * evidence. Reporting only the first is how a coverage map becomes marketing. Nothing here scans,
 * so the tab is honest about being as old as the run it read.
 */
export function standardsFromRuns(cwd: string): StandardsFacts {
  const { at, rows } = securityRowsFromRuns(cwd);
  const facts: StandardsFacts = { at, standards: [] };
  if (rows.length === 0) return facts;

  try {
    // Synchronous require: this module is imported by one command and must not pull the coverage
    // engine into every kit invocation.
    const req = createRequire(import.meta.url);
    const { COVERAGE_STANDARDS } = req(
      "./coverage/registry.js",
    ) as typeof import("./coverage/registry.js");
    const { buildStandardReport } = req(
      "./coverage/standard.js",
    ) as typeof import("./coverage/standard.js");
    const { buildCoverageReport } = req(
      "./coverage/coverage.js",
    ) as typeof import("./coverage/coverage.js");

    for (const std of COVERAGE_STANDARDS) {
      const summary =
        std.kind === "asvs"
          ? buildCoverageReport(rows as never).summary
          : buildStandardReport(std.descriptor!, rows as never).summary;
      facts.standards.push({
        key: std.key,
        label: std.label,
        version: std.version,
        total: summary.total,
        auto: summary.auto,
        verified: summary.autoVerified ?? 0,
        failing: summary.autoFailing ?? 0,
        unrun: summary.autoUnrun ?? 0,
        gap: summary.gap,
        manual: summary.manual,
        na: summary.na,
      });
    }
  } catch {
    /* coverage engine unavailable — an empty list, never invented numbers */
  }
  return facts;
}

/**
 * Declared keys and their exposure, from config and the saved run.
 *
 * Names only. This function never reads a value, and nothing it returns could carry one — the
 * question "are my keys exposed" must be answerable without handling the keys.
 */
export function keysFromConfigAndRun(cwd: string): KeysFacts {
  const facts: KeysFacts = {
    declared: 0,
    bySource: [],
    available: null,
    missing: [],
    history: null,
    envIgnored: null,
  };

  // [secrets.keys] — parsed with the same TOML reader the rest of kit uses.
  try {
    const req = createRequire(import.meta.url);
    const { parse } = req("smol-toml") as typeof import("smol-toml");
    const cfg = parse(readFileSync(join(cwd, ".kit.toml"), "utf-8")) as {
      secrets?: { keys?: Record<string, { source?: string }> };
    };
    const keys = cfg.secrets?.keys ?? {};
    facts.declared = Object.keys(keys).length;
    const counts = new Map<string, number>();
    for (const decl of Object.values(keys)) {
      const source = typeof decl?.source === "string" ? decl.source : "(unspecified)";
      counts.set(source, (counts.get(source) ?? 0) + 1);
    }
    facts.bySource = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  } catch {
    /* no config, or not parseable — declared stays 0 */
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const dir = join(cwd, ".kit", "runs");
    const newest = readdirSync(dir)
      .filter((f) => f.startsWith("check-") && f.endsWith(".json"))
      .sort()
      .pop();
    if (newest)
      parsed = JSON.parse(readFileSync(join(dir, newest), "utf-8")) as Record<string, unknown>;
  } catch {
    /* no run saved */
  }
  if (!parsed) return facts;

  const secrets = Array.isArray(parsed.secrets)
    ? (parsed.secrets as Array<Record<string, unknown>>)
    : null;
  if (secrets) {
    facts.available = secrets.filter((r) => r.available === true).length;
    facts.missing = secrets
      .filter((r) => r.available !== true && typeof r.name === "string")
      .map((r) => String(r.name));
  }

  const security = Array.isArray(parsed.security)
    ? (parsed.security as Array<Record<string, unknown>>)
    : [];
  const scan = security.find((r) => r.name === "secrets scan");
  if (scan && typeof scan.detail === "string") {
    // The counts live only in the row's prose, so they are read back out of it. A wording change
    // yields null rather than a wrong number — the row itself is still shown in `kit check`.
    const n = (re: RegExp): number | null => {
      const m = re.exec(scan.detail as string);
      return m ? Number(m[1]) : null;
    };
    const verifiedLive = n(/(\d+) VERIFIED-LIVE/i) ?? 0;
    const unverified = n(/(\d+) unverified secret-shaped/i);
    const examples = n(/(\d+) example credential/i) ?? 0;
    const accepted = n(/(\d+) accepted historical/i) ?? 0;
    if (unverified !== null || verifiedLive > 0) {
      facts.history = { verifiedLive, unverified: unverified ?? 0, examples, accepted };
    }
  }

  const gitignore = security.find(
    (r) => typeof r.name === "string" && /gitignore/i.test(String(r.name)),
  );
  if (gitignore && typeof gitignore.status === "string") {
    facts.envIgnored = gitignore.status === "pass";
  }

  return facts;
}

export function gatherUsage(cwd: string = process.cwd(), home = homedir()): UsageFacts {
  return {
    coverage: coverageFromRuns(cwd),
    standards: standardsFromRuns(cwd),
    keys: keysFromConfigAndRun(cwd),
    memory: memoryFromDb(),
    floor: floorFromLogs(cwd),
    triage: triageFromLog(cwd),
    machine: machineFromAnchor(cwd, home),
  };
}
