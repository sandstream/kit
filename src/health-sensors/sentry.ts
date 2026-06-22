import type { HealthFinding, HealthSensor } from "../health.js";

export interface SentryIssue {
  id?: string;
  title?: string;
  level?: string;
  status?: string;
}

export function parseSentryIssues(body: string): SentryIssue[] {
  try {
    const arr = JSON.parse(body) as SentryIssue[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export const sentrySensor: HealthSensor = {
  id: "sentry",
  async probe(_ctx, deps): Promise<HealthFinding[]> {
    const token = process.env.SENTRY_AUTH_TOKEN;
    const org = process.env.SENTRY_ORG;
    const project = process.env.SENTRY_PROJECT;
    const base = (process.env.SENTRY_URL || "https://sentry.io").replace(/\/+$/, "");
    const source = org && project ? `${org}/${project}` : "(sentry org/project unset)";
    if (!token || !org || !project) {
      return [{
        sensor: "sentry",
        source,
        status: "unknown",
        title: "Sentry probe skipped: SENTRY_AUTH_TOKEN / SENTRY_ORG / SENTRY_PROJECT not all set",
        detail: "set the three to enable the Sentry sensor",
      }];
    }
    // New unresolved issues in the last 24h = a fresh-errors signal (not the whole backlog).
    const q = encodeURIComponent("is:unresolved firstSeen:-24h");
    const url = `${base}/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?query=${q}&statsPeriod=24h`;
    const res = await deps.httpGet(url, { Authorization: `Bearer ${token}` });
    if (!res.ok) {
      return [{
        sensor: "sentry",
        source,
        status: "unknown",
        title: `Sentry API returned HTTP ${res.status}`,
        detail: "check SENTRY_AUTH_TOKEN scope / org+project / SENTRY_URL region",
      }];
    }
    const issues = parseSentryIssues(res.body);
    if (issues.length === 0) {
      return [{ sensor: "sentry", source, status: "green", title: "Sentry: no new unresolved issues in 24h" }];
    }
    const sample = issues[0]?.title ? ` (e.g. "${issues[0].title}")` : "";
    return [{
      sensor: "sentry",
      source,
      status: "red",
      severity: "high",
      title: `Sentry: ${issues.length} new unresolved issue(s) in 24h${sample}`,
      detail: "triage at the Sentry dashboard; may be a real regression or benign noise to filter",
      suggestedClass: "code",
    }];
  },
};
