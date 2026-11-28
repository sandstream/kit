/**
 * `permissions: write-all` reported as what it is: write to every scope of the job's GITHUB_TOKEN.
 *
 * gha-id-token.ts reports a workflow-level `write-all` only as its `id-token: write` part, so the
 * finding named one scope of many (kit-research `linkedin-batch-2026-11-27-vs-kit`).
 * `write-all` also grants `contents: write` (push to branches and tags), `packages: write`,
 * `actions: write`, `pull-requests: write` and the rest, to every step and every action the job
 * runs. GitHub's guidance is a read-only token by default and a write scope only on the job that
 * needs it:
 * https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/controlling-permissions-for-github_token
 *
 * Flagged at workflow level (every job without its own `permissions:` gets it, including jobs added
 * later) and on each job that sets it. A workflow with no `permissions:` block is not reported:
 * the token then follows the repository or organisation default, which this file does not show.
 * Deterministic line scan, no YAML dependency, like the rest of gha-audit.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { parseJobs } from "./gha-skip-gate.js";

const WRITE_ALL_RULE = {
  id: "CWE-250",
  source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/250.html",
  title: "Execution with Unnecessary Privileges",
};

const SCOPES =
  "contents, packages, actions, pull-requests, issues, deployments, pages, statuses, checks, " +
  "security-events, discussions, attestations and id-token";

const SUGGESTION =
  "aim for a read-only GITHUB_TOKEN: set `permissions: contents: read` (or `{}`) at the top, " +
  "and grant each write scope only on the job whose step needs it";

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => line.trim() !== "" && !line.trim().startsWith("#");
const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, "");

/** Whether the `permissions:` key at `indent` in `lines` is `write-all` (bare or quoted). */
function isWriteAll(lines: string[], indent: number): boolean {
  const key = lines.find((l) => indentOf(l) === indent && /^permissions\s*:/.test(l.trimStart()));
  if (key === undefined) return false;
  const value = stripComment(key)
    .trim()
    .replace(/^permissions\s*:/, "")
    .trim();
  return /^['"]?write-all['"]?$/.test(value);
}

/** One row for a workflow-level `write-all`, and one per job that sets it. Pure. */
export function auditWriteAll(content: string, file: string): SecurityCheckResult[] {
  const out: SecurityCheckResult[] = [];
  if (isWriteAll(content.split(/\r?\n/), 0)) {
    out.push({
      category: "supply-chain",
      name: `workflow-level permissions: write-all (${file})`,
      status: "warn",
      severity: "medium",
      detail:
        `write-all grants write to every scope (${SCOPES}), so the GITHUB_TOKEN of every job ` +
        "without its own permissions block, and every action those jobs run, can push commits and " +
        "tags, publish packages, edit pull requests and issues, and mint an OIDC token",
      suggestion: SUGGESTION,
      rule: WRITE_ALL_RULE,
    });
  }
  for (const job of parseJobs(content)) {
    const body = job.body.split("\n");
    if (!isWriteAll(body, indentOf(body.find(isContent) ?? ""))) continue;
    out.push({
      category: "supply-chain",
      name: `permissions: write-all on job ${job.id} (${file})`,
      status: "warn",
      severity: "medium",
      detail:
        `job "${job.id}" sets write-all, which grants write to every scope (${SCOPES}), so every ` +
        "step and action in it can push commits and tags, publish packages, edit pull requests and " +
        "issues, and mint an OIDC token",
      suggestion: SUGGESTION,
      rule: WRITE_ALL_RULE,
    });
  }
  return out;
}
