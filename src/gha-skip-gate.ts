/**
 * A gate that can skip itself green (GitHub Actions).
 *
 * A job whose job-level `if:` evaluates false is reported as *skipped*, and a skipped job satisfies
 * a required status check. So a pull-request job gated on a computed condition, typically "did this
 * PR touch the project" (`if: needs.changes.outputs.server == 'true'`), passes the merge gate without
 * running whenever the condition says no. If the change detection is wrong, every gated job skips and
 * the PR is green. One team found exactly that by hiding a server change from its affected-detection
 * on purpose: all six test shards skipped and reported green.
 *
 * The safe shape is an aggregator: a job that `needs` the gated jobs, runs with `if: always()` (or
 * `!cancelled()`), and fails unless their `result` is what it should be. kit's own `windows-native`
 * job is that shape. This rule flags a computed-skip job in a pull-request workflow that no such
 * aggregator covers.
 *
 * Deterministic line scan, no YAML dependency, like the rest of gha-audit. It does not know which
 * checks branch protection requires (that needs the API), so it warns rather than fails.
 */
import type { SecurityCheckResult } from "./check-security.js";

const SKIP_RULE = {
  id: "CWE-754",
  source: "cwe" as const,
  ref: "https://cwe.mitre.org/data/definitions/754.html",
  title: "Improper Check for Unusual or Exceptional Conditions",
};

export interface WorkflowJob {
  id: string;
  /** Job-level `if:` expression, or "" when the job has none. */
  cond: string;
  needs: string[];
  /** The job's whole text, for the aggregator's `.result` check. */
  body: string;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isContent = (line: string): boolean => line.trim() !== "" && !line.trim().startsWith("#");

function unquote(value: string): string {
  const v = value.trim();
  const q = new Set(["'", '"']);
  return v.length >= 2 && q.has(v[0]) && v[v.length - 1] === v[0] ? v.slice(1, -1) : v;
}

/** The value of `key:` at `indent` in `lines`, joining a `|`/`>` block scalar or a block list. */
function keyValue(lines: string[], indent: number, key: string): string[] | null {
  const at = lines.findIndex((l) => indentOf(l) === indent && l.trimStart().startsWith(`${key}:`));
  if (at < 0) return null;
  const inline = lines[at]
    .trimStart()
    .slice(key.length + 1)
    .trim();
  const more: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (isContent(line) && indentOf(line) <= indent) break;
    if (isContent(line)) more.push(line.trim());
  }
  if (inline === "" || /^[|>][-+]?$/.test(inline)) return more;
  return [inline];
}

function parseNeeds(value: string[] | null): string[] {
  if (!value) return [];
  return value
    .join(",")
    .replace(/[[\]]/g, "")
    .split(",")
    .map((v) => unquote(v.replace(/^-\s*/, "")))
    .filter((v) => v !== "");
}

function toJob(id: string, lines: string[]): WorkflowJob {
  const keyIndent = indentOf(lines.find(isContent) ?? "");
  return {
    id,
    cond: unquote((keyValue(lines, keyIndent, "if") ?? []).join(" ")),
    needs: parseNeeds(keyValue(lines, keyIndent, "needs")),
    body: lines.join("\n"),
  };
}

/** The lines under the top-level `jobs:` key, or [] when there is none. */
function jobsSection(lines: string[]): string[] {
  const start = lines.findIndex((l) => l.trimEnd() === "jobs:" || l.startsWith("jobs: #"));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => isContent(l) && indentOf(l) === 0);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The jobs of one workflow, with their job-level `if:` and `needs:`. Pure. */
export function parseJobs(content: string): WorkflowJob[] {
  const section = jobsSection(content.split(/\r?\n/));
  const first = section.find(isContent);
  if (!first) return [];
  const jobIndent = indentOf(first);
  const blocks: { id: string; lines: string[] }[] = [];
  for (const line of section) {
    const id = /^\s*([A-Za-z0-9_-]+):\s*$/.exec(line.replace(/\s+#.*$/, ""));
    if (id && indentOf(line) === jobIndent) blocks.push({ id: id[1], lines: [] });
    else blocks.at(-1)?.lines.push(line);
  }
  return blocks.map((b) => toJob(b.id, b.lines));
}

/** Whether the workflow runs on pull requests (or the merge queue), where checks gate a merge. */
export function gatesPullRequests(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const keys = new Set(["on", JSON.stringify("on"), "'on'"]);
  const at = lines.findIndex((l) => indentOf(l) === 0 && keys.has(l.split(":")[0].trim()));
  if (at < 0) return false;
  const end = lines.findIndex((l, n) => n > at && isContent(l) && indentOf(l) === 0);
  const block = lines.slice(at, end < 0 ? undefined : end).join("\n");
  return /\b(pull_request(_target)?|merge_group)\b/.test(block);
}

/** A job-level condition computed by another job: the skip is decided at run time. */
export const computedSkip = (cond: string): boolean => /\bneeds\.[\w-]+\.outputs\./.test(cond);

function aggregates(job: WorkflowJob, target: string): boolean {
  const always = /\balways\(\)|!\s*cancelled\(\)/.test(job.cond);
  return always && job.needs.includes(target) && /\.result\b/.test(job.body);
}

/** Flag computed-skip jobs no aggregator covers. Pure. */
export function auditSkippableGates(content: string, file: string): SecurityCheckResult[] {
  if (!gatesPullRequests(content)) return [];
  const jobs = parseJobs(content);
  return jobs
    .filter((j) => computedSkip(j.cond) && !jobs.some((a) => aggregates(a, j.id)))
    .map((j) => ({
      category: "supply-chain" as const,
      name: `skippable gate ${j.id} (${file})`,
      status: "warn" as const,
      severity: "medium" as const,
      detail:
        `job "${j.id}" runs only if \`${j.cond}\`; when that is false the job is skipped, and a ` +
        `skipped job passes a required check, so a pull request can merge without it running`,
      suggestion:
        `add an aggregator job with \`needs: [${j.id}]\` and \`if: always()\` that fails unless ` +
        `\`needs.${j.id}.result\` is "success" (or "skipped" only where that is intended), and ` +
        `require the aggregator instead`,
      rule: SKIP_RULE,
    }));
}
