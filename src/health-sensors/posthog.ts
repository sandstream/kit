import type { HealthFinding, HealthSensor } from "../health.js";

export interface PostHogHealthIssue {
  id?: string;
  kind?: string;
  severity?: string;
  status?: string;
  dismissed?: boolean;
  snoozed_until?: string | null;
  title?: string;
  summary?: string;
  link?: string;
}

export function parsePostHogHealthIssues(body: string): PostHogHealthIssue[] {
  try {
    const parsed = JSON.parse(body) as { results?: PostHogHealthIssue[] } | PostHogHealthIssue[];
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

export function activePostHogHealthIssues(issues: PostHogHealthIssue[]): PostHogHealthIssue[] {
  return issues.filter(
    (i) => (i.status ?? "").toLowerCase() === "active" && i.dismissed !== true && !i.snoozed_until,
  );
}

export function posthogApiBase(): string {
  const raw =
    process.env.POSTHOG_API_HOST ??
    process.env.POSTHOG_HOST ??
    process.env.NEXT_PUBLIC_POSTHOG_HOST ??
    "https://us.posthog.com";
  const base = raw.replace(/\/+$/, "").replace(/\/api$/, "");
  if (base === "https://us.i.posthog.com") return "https://us.posthog.com";
  if (base === "https://eu.i.posthog.com") return "https://eu.posthog.com";
  return base;
}

function severity(issue: PostHogHealthIssue): HealthFinding["severity"] {
  switch ((issue.severity ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "warning":
      return "medium";
    case "info":
      return "low";
    default:
      return "medium";
  }
}

export const posthogSensor: HealthSensor = {
  id: "posthog",
  async probe(_ctx, deps): Promise<HealthFinding[]> {
    const token = process.env.POSTHOG_PERSONAL_API_KEY;
    const project = process.env.POSTHOG_PROJECT_ID;
    const source = project ? `posthog/${project}` : "(posthog project unset)";
    if (!token || !project) {
      return [
        {
          sensor: "posthog",
          source,
          status: "unknown",
          title: "PostHog probe skipped: POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID not set",
          detail: "set both to enable PostHog health issue checks",
        },
      ];
    }

    const url = `${posthogApiBase()}/api/projects/${encodeURIComponent(
      project,
    )}/health_issues/?status=active&dismissed=false`;
    const res = await deps.httpGet(url, { Authorization: `Bearer ${token}` });
    if (!res.ok) {
      return [
        {
          sensor: "posthog",
          source,
          status: "unknown",
          title: `PostHog API returned HTTP ${res.status}`,
          detail: "check POSTHOG_PERSONAL_API_KEY scope / POSTHOG_PROJECT_ID / POSTHOG_API_HOST",
        },
      ];
    }

    const active = activePostHogHealthIssues(parsePostHogHealthIssues(res.body));
    if (active.length === 0) {
      return [
        {
          sensor: "posthog",
          source,
          status: "green",
          title: "PostHog: no active unsnoozed health issues",
        },
      ];
    }

    const first = active[0];
    const label = first.title ?? first.kind ?? first.id ?? "unknown issue";
    return [
      {
        sensor: "posthog",
        source,
        status: "red",
        severity: severity(first),
        title: `PostHog: ${active.length} active health issue(s)`,
        detail: label,
        suggestedClass: "code",
      },
    ];
  },
};
