import type { HealthFinding, HealthSensor } from "../health.js";

export interface VercelDeployment {
  uid?: string;
  state?: string;
  readyState?: string;
  created?: number;
  target?: string | null;
}

// Terminal Vercel deployment states; ERROR is the only "red" one (CANCELED = user-stopped).
const TERMINAL = new Set(["READY", "ERROR", "CANCELED"]);

function stateOf(d: VercelDeployment): string | undefined {
  return d.state ?? d.readyState;
}

export function parseVercelDeployments(body: string): VercelDeployment[] {
  try {
    const obj = JSON.parse(body) as { deployments?: VercelDeployment[] };
    return Array.isArray(obj.deployments) ? obj.deployments : [];
  } catch {
    return [];
  }
}

/** Most recent terminal production deployment; returned only when it errored. */
export function latestFailedVercel(deployments: VercelDeployment[]): VercelDeployment | null {
  const terminal = deployments.filter((d) => {
    const s = stateOf(d);
    return s !== undefined && TERMINAL.has(s);
  });
  if (terminal.length === 0) return null;
  const latest = terminal.reduce((a, b) => ((a.created ?? 0) >= (b.created ?? 0) ? a : b));
  return stateOf(latest) === "ERROR" ? latest : null;
}

export const vercelSensor: HealthSensor = {
  id: "vercel",
  async probe(ctx, deps): Promise<HealthFinding[]> {
    const projectId = ctx.vercel?.projectId;
    if (!projectId) {
      return [{
        sensor: "vercel",
        source: "(not linked)",
        status: "unknown",
        title: "Vercel probe skipped: project not linked",
        detail: "no .vercel/project.json — run `vercel link`",
      }];
    }
    const token = process.env.VERCEL_TOKEN;
    if (!token) {
      return [{
        sensor: "vercel",
        source: projectId,
        status: "unknown",
        title: "Vercel probe skipped: VERCEL_TOKEN not set",
        detail: "set VERCEL_TOKEN to enable the Vercel sensor",
      }];
    }
    const team = ctx.vercel?.orgId ? `&teamId=${encodeURIComponent(ctx.vercel.orgId)}` : "";
    const url = `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&limit=10${team}`;
    const res = await deps.httpGet(url, { Authorization: `Bearer ${token}` });
    if (!res.ok) {
      return [{
        sensor: "vercel",
        source: projectId,
        status: "unknown",
        title: `Vercel API returned HTTP ${res.status}`,
        detail: "check VERCEL_TOKEN scope / project + team access",
      }];
    }
    const failed = latestFailedVercel(parseVercelDeployments(res.body));
    if (!failed) {
      return [{ sensor: "vercel", source: projectId, status: "green", title: "Vercel: latest production deploy green" }];
    }
    return [{
      sensor: "vercel",
      source: projectId,
      status: "red",
      severity: "high",
      title: "Vercel production deploy failed",
      detail: `deployment ${failed.uid ?? "?"} state=ERROR`,
      suggestedClass: "code",
    }];
  },
};
