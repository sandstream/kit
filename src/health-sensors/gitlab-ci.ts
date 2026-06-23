import type { HealthFinding, HealthSensor } from "../health.js";
import { parseGitRemote } from "./remote.js";

export interface GlPipeline {
  id: number;
  status: string;
  ref: string;
  sha?: string;
  web_url?: string;
  created_at: string;
}

// GitLab pipeline terminal states (non-terminal: created/waiting/preparing/pending/running/manual/scheduled).
const TERMINAL = new Set(["success", "failed", "canceled", "skipped"]);

export function parseGitlabPipelines(json: string): GlPipeline[] {
  try {
    const arr = JSON.parse(json) as GlPipeline[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** Most recent terminal pipeline; returned only when it failed. */
export function latestFailedPipeline(pipelines: GlPipeline[]): GlPipeline | null {
  const terminal = pipelines.filter((p) => TERMINAL.has(p.status));
  if (terminal.length === 0) return null;
  const latest = terminal.reduce((a, b) => (a.created_at >= b.created_at ? a : b));
  return latest.status === "failed" ? latest : null;
}

export const gitlabSensor: HealthSensor = {
  id: "gitlab-ci",
  async probe(_ctx, deps): Promise<HealthFinding[]> {
    const remoteRes = await deps.runCli("git", ["remote", "get-url", "origin"]);
    const slug = remoteRes.ok ? parseGitRemote(remoteRes.stdout) : null;
    if (!slug) {
      return [
        {
          sensor: "gitlab-ci",
          source: "(no git remote)",
          status: "unknown",
          title: "GitLab CI probe could not resolve the remote",
          detail: "git remote get-url origin failed",
        },
      ];
    }
    const source = `${slug.host}/${slug.path}`;
    const token = process.env.GITLAB_TOKEN;
    if (!token) {
      return [
        {
          sensor: "gitlab-ci",
          source,
          status: "unknown",
          title: "GitLab CI probe skipped: GITLAB_TOKEN not set",
          detail: "set GITLAB_TOKEN (read_api) to enable the GitLab CI sensor",
        },
      ];
    }
    const url = `https://${slug.host}/api/v4/projects/${encodeURIComponent(slug.path)}/pipelines?per_page=20`;
    const res = await deps.httpGet(url, { "PRIVATE-TOKEN": token });
    if (!res.ok) {
      return [
        {
          sensor: "gitlab-ci",
          source,
          status: "unknown",
          title: `GitLab CI API returned HTTP ${res.status}`,
          detail: "check GITLAB_TOKEN scope / project access",
        },
      ];
    }
    const failed = latestFailedPipeline(parseGitlabPipelines(res.body));
    if (!failed) {
      return [
        { sensor: "gitlab-ci", source, status: "green", title: "GitLab CI: latest pipeline green" },
      ];
    }
    return [
      {
        sensor: "gitlab-ci",
        source,
        status: "red",
        severity: "high",
        title: `GitLab CI pipeline failing on ${failed.ref}`,
        detail: `pipeline #${failed.id} failed (${failed.created_at})`,
        suggestedClass: "code",
      },
    ];
  },
};
