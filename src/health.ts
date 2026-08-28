import type { kitConfig } from "./config.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";
import { githubActionsSensor } from "./health-sensors/github-actions.js";
import { githubDependabotSensor } from "./health-sensors/github-dependabot.js";
import { gitlabSensor } from "./health-sensors/gitlab-ci.js";
import { bitbucketSensor } from "./health-sensors/bitbucket-pipelines.js";
import { vercelSensor } from "./health-sensors/vercel.js";
import { sentrySensor } from "./health-sensors/sentry.js";
import { resendSensor } from "./health-sensors/resend.js";
import { posthogSensor } from "./health-sensors/posthog.js";
import { tinybirdSensor } from "./health-sensors/tinybird.js";
import { supabaseAdvisorSensor } from "./health-sensors/supabase-advisor.js";
import { tlsCertSensor } from "./health-sensors/tls-cert.js";

export type HealthStatus = "green" | "red" | "unknown";
export type HealthClass = "code" | "human" | "noise";

export interface HealthFinding {
  sensor: string;
  /** The account/org/ref/repo actually probed (the verify-source record). */
  source: string;
  status: HealthStatus;
  severity?: "critical" | "high" | "medium" | "low";
  title: string;
  detail?: string;
  suggestedClass?: HealthClass;
}

export interface HealthCtx {
  cwd: string;
  config: kitConfig;
  /** True when the repo has a git remote (computed by the CLI layer). */
  gitRemote?: boolean;
  /** True when a .gitlab-ci.yml is present (GitLab CI in use). */
  gitlabCi?: boolean;
  /** True when a bitbucket-pipelines.yml is present (Bitbucket Pipelines in use). */
  bitbucketPipelines?: boolean;
  /** True when .github/dependabot.yml is present. */
  githubDependabot?: boolean;
  /** Vercel link from .vercel/project.json (orgId = teamId, projectId), if present. */
  vercel?: { orgId?: string; projectId?: string };
  /** Service ids the project is connected to (from the registry), for dep-detected sensors. */
  services?: string[];
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
}

export interface HealthDeps {
  runCli(command: string, args: string[]): Promise<ExecResult>;
  /** Read-only HTTP GET for API-based probes (Bitbucket, future Vercel/Sentry/Resend). */
  httpGet(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
}

export interface HealthSensor {
  id: string;
  probe(ctx: HealthCtx, deps: HealthDeps): Promise<HealthFinding[]>;
}

/** Runs every sensor; a sensor that throws becomes an `unknown` finding (never dropped). */
export async function runHealth(
  ctx: HealthCtx,
  sensors: HealthSensor[],
  deps: HealthDeps,
): Promise<HealthFinding[]> {
  const all = await Promise.all(
    sensors.map(async (s): Promise<HealthFinding[]> => {
      try {
        return await s.probe(ctx, deps);
      } catch (e) {
        return [
          {
            sensor: s.id,
            source: "(probe errored)",
            status: "unknown",
            title: `${s.id} probe failed`,
            detail: e instanceof Error ? e.message : String(e),
          },
        ];
      }
    }),
  );
  return all.flat();
}

export const HEALTH_SENSORS: HealthSensor[] = [
  githubActionsSensor,
  githubDependabotSensor,
  gitlabSensor,
  bitbucketSensor,
  vercelSensor,
  sentrySensor,
  resendSensor,
  posthogSensor,
  tinybirdSensor,
  supabaseAdvisorSensor,
  tlsCertSensor,
];

const SERVICE_HEALTH_SENSORS = new Set(["sentry", "resend", "posthog", "tinybird"]);

/** Returns the sensors whose underlying CI platform the project actually uses. */
export function selectSensors(ctx: HealthCtx): HealthSensor[] {
  return HEALTH_SENSORS.filter((s) => {
    if (SERVICE_HEALTH_SENSORS.has(s.id)) {
      return ctx.services?.includes(s.id) === true;
    }
    switch (s.id) {
      case "github-actions":
        return ctx.gitRemote === true || ctx.config.context?.github !== undefined;
      case "github-dependabot":
        return ctx.gitRemote === true && ctx.githubDependabot === true;
      case "gitlab-ci":
        return ctx.gitlabCi === true;
      case "bitbucket-pipelines":
        return ctx.bitbucketPipelines === true;
      case "vercel":
        return Boolean(ctx.vercel?.projectId);
      case "supabase-advisor":
        return ctx.services?.includes("supabase") === true;
      case "tls-cert":
        // Opt-in: only when the user names host(s) to check.
        return Boolean(process.env.KIT_TLS_HOST);
      default:
        return false;
    }
  });
}

export const defaultHealthDeps: HealthDeps = {
  runCli: (command, args) => execFileNoThrow(command, args, { timeout: 15_000 }),
  httpGet: async (url, headers) => {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
      return { ok: res.ok, status: res.status, body: await res.text() };
    } catch (e) {
      // Network error / timeout → not ok, status 0; the sensor maps this to `unknown`.
      return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e) };
    }
  },
};

const MARK: Record<HealthStatus, string> = { green: "✓", red: "✗", unknown: "?" };

export function healthOk(findings: HealthFinding[]): boolean {
  return findings.every((f) => f.status === "green");
}

/** Pure human formatter — returns lines + red count (CLI adds color). */
export function formatHealth(findings: HealthFinding[]): {
  lines: string[];
  redCount: number;
  nonGreenCount: number;
} {
  const lines = findings.map((f) => `${MARK[f.status]} [${f.sensor}] ${f.title}  (${f.source})`);
  const redCount = findings.filter((f) => f.status === "red").length;
  const nonGreenCount = findings.filter((f) => f.status !== "green").length;
  return { lines, redCount, nonGreenCount };
}
