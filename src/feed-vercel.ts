/**
 * Read the latest production deploy of every Vercel project and turn a failed one into a ledger
 * finding. Read-only: it calls `vercel api` (GET), which uses the login the Vercel CLI already has,
 * so kit never holds or stores a token. Project names are chosen by whoever owns the project, so
 * they are cleaned before they reach the ledger.
 *
 * Same rules as the GitHub feed: a call that fails or a list that does not end yields `null`, never
 * an empty list (an empty list closes every open item), and a failure older than 14 days says
 * nothing about today.
 */
import { cleanText, FeedAuthError } from "./feed-github.js";
import type { SyncFinding } from "./memory/pal.js";
import type { ReadCommand } from "./review-receipt-io.js";
import { redactSecrets } from "./utils/redactSecrets.js";

export interface VercelFeed {
  /** "personal" or the team id or slug that was read. */
  scope: string;
  /** Failed production deploys, or null when Vercel could not be read to the end. */
  production: SyncFinding[] | null;
  notes: string[];
}

const SETTLED = new Set(["READY", "ERROR"]);
const MAX_AGE_DAYS = 14;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const NOT_LOGGED_IN =
  /No existing credentials|vercel login|token is not valid|invalid token|Not authorized|\((?:401|403)\)/i;

export function parseTeam(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`team must be a team id or slug, got "${cleanText(value, 60)}"`);
  }
  return value;
}

interface Deployment {
  name: string;
  state: string;
  created: number;
  inspectorUrl: string;
}

function deployment(raw: unknown): Deployment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const state = typeof r.state === "string" ? r.state : r.readyState;
  if (typeof r.name !== "string" || typeof state !== "string" || typeof r.created !== "number") {
    return null;
  }
  return {
    name: r.name,
    state,
    created: r.created,
    inspectorUrl: typeof r.inspectorUrl === "string" ? r.inspectorUrl : "",
  };
}

function readPage(run: ReadCommand, team: string | undefined, until: number | null) {
  const query = [`limit=${PAGE_SIZE}`, "target=production"];
  if (team) query.push(`teamId=${team}`);
  if (until !== null) query.push(`until=${until}`);
  const out = run("vercel", ["api", `/v6/deployments?${query.join("&")}`], process.cwd());
  const body = JSON.parse(out) as { deployments?: unknown; pagination?: { next?: unknown } };
  if (!Array.isArray(body.deployments)) throw new Error("unexpected Vercel response");
  const next = body.pagination?.next;
  return {
    deployments: body.deployments.map(deployment).filter((d): d is Deployment => d !== null),
    next: typeof next === "number" ? next : null,
  };
}

function allDeployments(run: ReadCommand, team: string | undefined): Deployment[] {
  const all: Deployment[] = [];
  let until: number | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = readPage(run, team, until);
    all.push(...page.deployments);
    if (page.next === null) return all;
    until = page.next;
  }
  throw new Error(
    `more than ${MAX_PAGES * PAGE_SIZE} production deployments, list not read to the end`,
  );
}

function judge(deployments: Deployment[], now: number, notes: string[]): SyncFinding[] {
  const latest = new Map<string, Deployment>();
  for (const d of deployments) {
    const seen = latest.get(d.name);
    if (SETTLED.has(d.state) && (!seen || d.created > seen.created)) latest.set(d.name, d);
  }
  const found: SyncFinding[] = [];
  for (const d of latest.values()) {
    if (d.state !== "ERROR") continue;
    const name = cleanText(d.name, 80);
    const days = Math.floor((now - d.created) / 86_400_000);
    if (days > MAX_AGE_DAYS) {
      notes.push(`Vercel production deploy of ${name} failed ${days} days ago; not tracked`);
      continue;
    }
    found.push({
      dedupKey: `vercel:${name}:production`,
      title: `Vercel deploy failed: ${name} (production)`,
      detail: cleanText(d.inspectorUrl),
    });
  }
  return found;
}

/** The message of a failed child process starts with the command line; the error is on a later line. */
function errorLine(reason: string): string {
  const line = reason.split("\n").find((l) => l.trim() !== "" && !l.startsWith("Command failed"));
  return (line ?? "unknown error").slice(0, 200);
}

export function fetchVercelFeed(
  run: ReadCommand,
  teamName?: string,
  now: number = Date.now(),
): VercelFeed {
  const team = teamName === undefined ? undefined : parseTeam(teamName);
  const notes: string[] = [];
  try {
    return {
      scope: team ?? "personal",
      production: judge(allDeployments(run, team), now, notes),
      notes,
    };
  } catch (error) {
    const reason = redactSecrets(error instanceof Error ? error.message : String(error));
    if (NOT_LOGGED_IN.test(reason)) {
      throw new FeedAuthError(
        "Vercel refused the login or the scope. Run: vercel login, or check access to the team",
      );
    }
    notes.push(`Vercel not read: ${errorLine(reason)}`);
    return { scope: team ?? "personal", production: null, notes };
  }
}
