import type { HealthFinding, HealthSensor } from "../health.js";

export interface TinybirdJob {
  id?: string;
  job_id?: string;
  kind?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  job_url?: string;
  datasource?: { name?: string };
}

export function parseTinybirdJobs(body: string): TinybirdJob[] {
  try {
    const parsed = JSON.parse(body) as { jobs?: TinybirdJob[] } | TinybirdJob[];
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

export function tinybirdJobsByStatus(jobs: TinybirdJob[]): {
  failed: TinybirdJob[];
  pending: TinybirdJob[];
} {
  const failed = jobs.filter((j) => (j.status ?? "").toLowerCase() === "error");
  const pending = jobs.filter((j) => {
    const status = (j.status ?? "").toLowerCase();
    return status === "waiting" || status === "working";
  });
  return { failed, pending };
}

function jobLabel(job: TinybirdJob): string {
  const id = job.job_id ?? job.id ?? "?";
  const kind = job.kind ?? "job";
  const ds = job.datasource?.name ? ` datasource=${job.datasource.name}` : "";
  return `${kind} ${id}${ds}`;
}

export const tinybirdSensor: HealthSensor = {
  id: "tinybird",
  async probe(_ctx, deps): Promise<HealthFinding[]> {
    const token = process.env.TINYBIRD_TOKEN;
    const base = (process.env.TINYBIRD_API_URL ?? "https://api.tinybird.co").replace(/\/+$/, "");
    if (!token) {
      return [
        {
          sensor: "tinybird",
          source: "tinybird",
          status: "unknown",
          title: "Tinybird probe skipped: TINYBIRD_TOKEN not set",
          detail: "set TINYBIRD_TOKEN to enable Tinybird job checks",
        },
      ];
    }

    const res = await deps.httpGet(`${base}/v0/jobs`, { Authorization: `Bearer ${token}` });
    if (!res.ok) {
      return [
        {
          sensor: "tinybird",
          source: base,
          status: "unknown",
          title: `Tinybird API returned HTTP ${res.status}`,
          detail: "check TINYBIRD_TOKEN / TINYBIRD_API_URL",
        },
      ];
    }

    const { failed, pending } = tinybirdJobsByStatus(parseTinybirdJobs(res.body));
    if (failed.length > 0) {
      return [
        {
          sensor: "tinybird",
          source: base,
          status: "red",
          severity: "high",
          title: `Tinybird: ${failed.length} failed job(s) in recent job history`,
          detail: jobLabel(failed[0]),
          suggestedClass: "code",
        },
      ];
    }
    if (pending.length > 0) {
      return [
        {
          sensor: "tinybird",
          source: base,
          status: "unknown",
          severity: "medium",
          title: `Tinybird: ${pending.length} job(s) still running or waiting`,
          detail: `${jobLabel(pending[0])}; wait before declaring green`,
          suggestedClass: "human",
        },
      ];
    }

    return [
      {
        sensor: "tinybird",
        source: base,
        status: "green",
        title: "Tinybird: no failed or pending jobs in recent job history",
      },
    ];
  },
};
