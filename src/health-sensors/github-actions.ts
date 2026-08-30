import type { HealthCtx, HealthDeps, HealthFinding, HealthSensor } from "../health.js";

export interface GhRun {
  name: string;
  status: string;
  conclusion: string;
  createdAt: string;
  databaseId: number;
}

const FAIL_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "startup_failure",
  "cancelled",
  "action_required",
]);

export function parseGitHubRuns(json: string): GhRun[] {
  try {
    const arr = JSON.parse(json) as GhRun[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Names of workflows whose state is "active" (i.e. not disabled). */
export function activeWorkflowNames(json: string): Set<string> {
  try {
    const arr = JSON.parse(json) as { name: string; state: string }[];
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((w) => w.state === "active").map((w) => w.name));
  } catch {
    return new Set();
  }
}

/**
 * Latest completed run per workflow name; included when that run failed.
 * When `active` is a non-empty set, workflows not in it (disabled) are excluded
 * so a stale failure from a dead workflow is not reported. An empty/omitted set
 * means "states unknown" and applies no filter (fail open to reporting).
 */
export function failingWorkflows(
  runs: GhRun[],
  active?: Set<string>,
): { name: string; createdAt: string }[] {
  return latestWorkflowRuns(runs, active)
    .filter((r) => r.status === "completed" && FAIL_CONCLUSIONS.has(r.conclusion))
    .map((r) => ({ name: r.name, createdAt: r.createdAt }));
}

export function pendingWorkflows(
  runs: GhRun[],
  active?: Set<string>,
): { name: string; status: string; createdAt: string }[] {
  return latestWorkflowRuns(runs, active)
    .filter((r) => r.status !== "completed")
    .map((r) => ({ name: r.name, status: r.status, createdAt: r.createdAt }));
}

function latestWorkflowRuns(runs: GhRun[], active?: Set<string>): GhRun[] {
  const latest = new Map<string, GhRun>();
  for (const r of runs) {
    const cur = latest.get(r.name);
    if (!cur || r.createdAt > cur.createdAt) latest.set(r.name, r);
  }
  const filterDisabled = active !== undefined && active.size > 0;
  return [...latest.values()].filter((r) => !filterDisabled || active.has(r.name));
}

export const githubActionsSensor: HealthSensor = {
  id: "github-actions",
  async probe(ctx: HealthCtx, deps: HealthDeps): Promise<HealthFinding[]> {
    const repoRes = await deps.runCli("gh", ["repo", "view", "--json", "nameWithOwner"]);
    if (!repoRes.ok) {
      return [
        {
          sensor: "github-actions",
          source: "(no gh auth / no remote)",
          status: "unknown",
          title: "GitHub Actions probe could not resolve the repo",
          detail: "gh repo view failed — run `gh auth status`",
        },
      ];
    }
    let nwo = "";
    try {
      nwo = (JSON.parse(repoRes.stdout) as { nameWithOwner: string }).nameWithOwner ?? "";
    } catch {
      nwo = "";
    }
    const wantOrg = ctx.config.context?.github?.org;
    if (wantOrg && nwo && nwo.split("/")[0] !== wantOrg) {
      return [
        {
          sensor: "github-actions",
          source: nwo,
          status: "unknown",
          title: "GitHub repo does not match locked context org",
          detail: `context expects org "${wantOrg}" but gh repo is "${nwo}"`,
        },
      ];
    }

    const listRes = await deps.runCli("gh", [
      "run",
      "list",
      "--limit",
      "30",
      "--json",
      "name,status,conclusion,createdAt,databaseId",
    ]);
    if (!listRes.ok) {
      return [
        {
          sensor: "github-actions",
          source: nwo || "(unknown repo)",
          status: "unknown",
          title: "GitHub Actions run list failed",
          detail: listRes.stderr || "gh run list returned non-zero",
        },
      ];
    }

    // Workflow states so a disabled workflow's stale failure is not flagged.
    // If this call fails, `active` stays empty → no filtering (fail open).
    const wfRes = await deps.runCli("gh", ["workflow", "list", "--json", "name,state"]);
    const active = wfRes.ok ? activeWorkflowNames(wfRes.stdout) : new Set<string>();

    const runs = parseGitHubRuns(listRes.stdout);
    const pending = pendingWorkflows(runs, active);
    const failing = failingWorkflows(runs, active);
    if (pending.length === 0 && failing.length === 0) {
      return [
        {
          sensor: "github-actions",
          source: nwo,
          status: "green",
          title: "GitHub Actions: all workflows green",
        },
      ];
    }
    return [
      ...pending.map((w) => ({
        sensor: "github-actions",
        source: nwo,
        status: "unknown" as const,
        severity: "medium" as const,
        title: `GitHub Actions workflow pending: ${w.name}`,
        detail: `latest run of "${w.name}" is ${w.status} (${w.createdAt}); wait before declaring green`,
        suggestedClass: "human" as const,
      })),
      ...failing.map((w) => ({
        sensor: "github-actions",
        source: nwo,
        status: "red" as const,
        severity: "high" as const,
        title: `GitHub Actions workflow failing: ${w.name}`,
        detail: `latest run of "${w.name}" failed (${w.createdAt})`,
        suggestedClass: "code" as const,
      })),
    ];
  },
};
