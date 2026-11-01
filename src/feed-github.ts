/**
 * Read what GitHub already knows is broken (failed workflows on the default branch, open Dependabot
 * alerts) and turn it into ledger findings, so the failure mail is not the only place it lives.
 *
 * Zero-LLM and read-only: `gh api` GET calls only. Everything GitHub returns is data from outside
 * the repo (workflow names are chosen by whoever can push), so it is cleaned before it reaches the
 * ledger and never interpreted.
 *
 * A call that fails yields `null`, not an empty list. An empty list means "nothing is broken" and
 * the ledger sync closes every open item that is absent from it, so a rate limit would otherwise
 * clear real blockers.
 */
import type { SyncFinding } from "./memory/pal.js";
import type { ReadCommand } from "./review-receipt-io.js";
import { redactSecrets } from "./utils/redactSecrets.js";

export interface GithubFeed {
  repo: string;
  branch: string;
  /** Failed workflows, or null when GitHub could not be read. */
  ci: SyncFinding[] | null;
  /** Open Dependabot alerts, or null when they could not be read. */
  dependabot: SyncFinding[] | null;
  /** Why a source was skipped, for the person reading the output. */
  notes: string[];
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const JUDGED = new Set(["success", ...FAILED]);
// Only a push or a schedule says how the branch itself is doing. A manual run, or a run for a pull
// request, can fail for reasons that have nothing to do with the branch, and a workflow that never
// runs on the branch would otherwise keep a months-old failure open for good.
const BRANCH_EVENTS = new Set(["push", "schedule"]);
// A failure this old describes an earlier version of the workflow or the branch, not today's state.
const MAX_AGE_DAYS = 14;
const RUNS_WINDOW = 10;

/** gh is missing a login. The message carries the fix, so the caller can print it as is. */
export class FeedAuthError extends Error {
  constructor() {
    super("GitHub is not logged in for kit. Run: gh auth login");
    this.name = "FeedAuthError";
  }
}

function isAuthFailure(reason: string): boolean {
  return /HTTP 401|Bad credentials|gh auth login|not logged in/i.test(reason);
}

export function parseRepo(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split("/").includes("..")) {
    throw new Error(`repository must look like owner/name, got "${cleanText(value, 60)}"`);
  }
  return value;
}

export function cleanText(value: unknown, max = 160): string {
  if (typeof value !== "string") return "";
  return redactSecrets(value.replace(/[\u0000-\u001f\u007f]+/g, " "))
    .trim()
    .slice(0, max);
}

function lines(output: string): unknown[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("unexpected GitHub response");
  }
  return value as Record<string, unknown>;
}

function gh(run: ReadCommand, path: string, jq: string, paginate = false): string {
  const args = ["api", ...(paginate ? ["--paginate"] : []), path, "--jq", jq];
  return run("gh", args, process.cwd());
}

function defaultBranch(repo: string, run: ReadCommand): string {
  let branch: string;
  try {
    branch = gh(run, `repos/${repo}`, ".default_branch").trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (isAuthFailure(reason)) throw new FeedAuthError();
    throw error;
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/.test(branch) || branch.includes("..")) {
    throw new Error("default branch is not a plain ref name");
  }
  return branch;
}

function ciFindings(
  repo: string,
  branch: string,
  run: ReadCommand,
  now: number,
  notes: string[],
): SyncFinding[] {
  const workflows = lines(
    gh(
      run,
      `repos/${repo}/actions/workflows?per_page=100`,
      '.workflows[] | select(.state == "active") | {id, name}',
      true,
    ),
  ).map(record);
  const found: SyncFinding[] = [];
  for (const workflow of workflows) {
    const id = workflow.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("invalid workflow id");
    const query = `branch=${encodeURIComponent(branch)}&status=completed&per_page=${RUNS_WINDOW}`;
    const out = gh(
      run,
      `repos/${repo}/actions/workflows/${id}/runs?${query}`,
      "[.workflow_runs[] | {conclusion, html_url, head_sha, event, created_at}]",
    );
    const latest = (JSON.parse(out) as unknown[])
      .map(record)
      .find(
        (r) =>
          typeof r.conclusion === "string" &&
          JUDGED.has(r.conclusion) &&
          typeof r.event === "string" &&
          BRANCH_EVENTS.has(r.event),
      );
    if (!latest || !FAILED.has(latest.conclusion as string)) continue;
    const name = cleanText(workflow.name, 80);
    const days = Math.floor((now - Date.parse(String(latest.created_at))) / 86_400_000);
    if (!(days <= MAX_AGE_DAYS)) {
      notes.push(`CI last ran on ${branch} ${days} days ago and failed; not tracked: ${name}`);
      continue;
    }
    found.push({
      dedupKey: `ci:${name}:${branch}`,
      title: `CI failed: ${name} on ${branch}`,
      detail: `${cleanText(latest.html_url)} (${cleanText(latest.head_sha, 7)})`,
    });
  }
  return found;
}

function alertFindings(repo: string, run: ReadCommand): SyncFinding[] {
  const jq =
    ".[] | {ghsa: .security_advisory.ghsa_id, pkg: .dependency.package.name, sev: .security_advisory.severity, summary: .security_advisory.summary, url: .html_url}";
  return lines(gh(run, `repos/${repo}/dependabot/alerts?state=open&per_page=100`, jq, true))
    .map(record)
    .map((a) => {
      const pkg = cleanText(a.pkg, 80);
      return {
        dedupKey: `dep:${cleanText(a.ghsa, 40)}:${pkg}`,
        title: `Dependabot ${cleanText(a.sev, 12)}: ${pkg}`,
        detail: [cleanText(a.summary), cleanText(a.url)].filter(Boolean).join(" "),
      };
    });
}

function explain(label: string, reason: string): string {
  if (label === "Dependabot" && /HTTP 403/.test(reason)) {
    return "Dependabot not read: the token cannot read alerts. Run: gh auth refresh -s security_events";
  }
  if (label === "Dependabot" && /HTTP 404/.test(reason)) {
    return "Dependabot alerts are off for this repository, so there is nothing to read";
  }
  return `${label} not read: ${reason.split("\n")[0]?.slice(0, 200) ?? "unknown error"}`;
}

function attempt<T>(label: string, notes: string[], read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    const reason = redactSecrets(error instanceof Error ? error.message : String(error));
    notes.push(explain(label, reason));
    return null;
  }
}

export function fetchGithubFeed(
  repoName: string,
  run: ReadCommand,
  now: number = Date.now(),
): GithubFeed {
  const repo = parseRepo(repoName);
  const branch = defaultBranch(repo, run);
  const notes: string[] = [];
  return {
    repo,
    branch,
    ci: attempt("CI", notes, () => ciFindings(repo, branch, run, now, notes)),
    dependabot: attempt("Dependabot", notes, () => alertFindings(repo, run)),
    notes,
  };
}
