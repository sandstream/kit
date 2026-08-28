import type { HealthCtx, HealthDeps, HealthFinding, HealthSensor } from "../health.js";

export interface DependabotCheck {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

export interface DependabotPr {
  number: number;
  title: string;
  url?: string;
  isDraft?: boolean;
  mergeStateStatus?: string;
  statusCheckRollup?: DependabotCheck[];
}

const FAIL_STATES = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "CANCELLED",
  "ACTION_REQUIRED",
]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED", "REQUESTED", "QUEUED", "IN_PROGRESS"]);

export function parseDependabotPrs(json: string): DependabotPr[] {
  try {
    const arr = JSON.parse(json) as DependabotPr[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function dependabotPrFindings(repo: string, prs: DependabotPr[]): HealthFinding[] {
  if (prs.length === 0) {
    return [
      {
        sensor: "github-dependabot",
        source: repo,
        status: "green",
        title: "Dependabot: no open PRs",
      },
    ];
  }

  return prs.map((pr) => {
    const label = `#${pr.number} ${pr.title}`;
    const mergeState = (pr.mergeStateStatus ?? "").toUpperCase();
    if (mergeState === "DIRTY") {
      return {
        sensor: "github-dependabot",
        source: repo,
        status: "red",
        severity: "high",
        title: `Dependabot PR has merge conflicts: ${label}`,
        detail: pr.url,
        suggestedClass: "code",
      };
    }
    if (mergeState === "UNKNOWN") {
      return {
        sensor: "github-dependabot",
        source: repo,
        status: "unknown",
        severity: "medium",
        title: `Dependabot PR mergeability pending: ${label}`,
        detail: pr.url,
        suggestedClass: "human",
      };
    }

    const checkState = dependabotCheckState(pr.statusCheckRollup ?? []);
    if (checkState === "failing") {
      return {
        sensor: "github-dependabot",
        source: repo,
        status: "red",
        severity: "high",
        title: `Dependabot PR checks failing: ${label}`,
        detail: pr.url,
        suggestedClass: "code",
      };
    }
    if (checkState === "pending") {
      return {
        sensor: "github-dependabot",
        source: repo,
        status: "unknown",
        severity: "medium",
        title: `Dependabot PR checks pending: ${label}`,
        detail: pr.url,
        suggestedClass: "human",
      };
    }

    return {
      sensor: "github-dependabot",
      source: repo,
      status: "red",
      severity: "low",
      title: `Dependabot PR ready for review: ${label}`,
      detail: pr.url,
      suggestedClass: "code",
    };
  });
}

function dependabotCheckState(checks: DependabotCheck[]): "ready" | "pending" | "failing" {
  if (checks.some((c) => checkFailing(c))) return "failing";
  if (checks.some((c) => checkPending(c))) return "pending";
  return "ready";
}

function checkFailing(check: DependabotCheck): boolean {
  const conclusion = check.conclusion?.toUpperCase();
  const state = check.state?.toUpperCase();
  return Boolean((conclusion && FAIL_STATES.has(conclusion)) || (state && FAIL_STATES.has(state)));
}

function checkPending(check: DependabotCheck): boolean {
  const status = check.status?.toUpperCase();
  const state = check.state?.toUpperCase();
  return Boolean(
    (status && status !== "COMPLETED") ||
    (state && PENDING_STATES.has(state)) ||
    (!status && !state && !check.conclusion),
  );
}

export const githubDependabotSensor: HealthSensor = {
  id: "github-dependabot",
  async probe(_ctx: HealthCtx, deps: HealthDeps): Promise<HealthFinding[]> {
    const repoRes = await deps.runCli("gh", ["repo", "view", "--json", "nameWithOwner"]);
    if (!repoRes.ok) {
      return [
        {
          sensor: "github-dependabot",
          source: "(no gh auth / no remote)",
          status: "unknown",
          title: "Dependabot probe could not resolve the repo",
          detail: "gh repo view failed",
        },
      ];
    }
    let repo: string;
    try {
      repo = (JSON.parse(repoRes.stdout) as { nameWithOwner?: string }).nameWithOwner ?? "";
    } catch {
      repo = "";
    }

    const prRes = await deps.runCli("gh", [
      "pr",
      "list",
      "--state",
      "open",
      "--author",
      "app/dependabot",
      "--json",
      "number,title,url,isDraft,mergeStateStatus,statusCheckRollup,updatedAt",
    ]);
    if (!prRes.ok) {
      return [
        {
          sensor: "github-dependabot",
          source: repo || "(unknown repo)",
          status: "unknown",
          title: "Dependabot PR list failed",
          detail: prRes.stderr || "gh pr list returned non-zero",
        },
      ];
    }

    return dependabotPrFindings(repo || "(unknown repo)", parseDependabotPrs(prRes.stdout));
  },
};
