import type { HealthFinding, HealthSensor } from "../health.js";
import { parseGitRemote } from "./remote.js";

export interface BbPipeline {
  uuid?: string;
  build_number?: number;
  state?: { name?: string; result?: { name?: string } };
  target?: { ref_name?: string };
  created_on: string;
}

// Bitbucket pipeline result names that mean "red" (STOPPED = user-cancelled, not a failure).
const BB_RED = new Set(["FAILED", "ERROR"]);

export function parseBitbucketPipelines(body: string): BbPipeline[] {
  try {
    const obj = JSON.parse(body) as { values?: BbPipeline[] };
    return Array.isArray(obj.values) ? obj.values : [];
  } catch {
    return [];
  }
}

/** Most recent COMPLETED pipeline; returned only when its result is FAILED/ERROR. */
export function latestFailedBitbucket(pipelines: BbPipeline[]): BbPipeline | null {
  const completed = pipelines.filter((p) => p.state?.name === "COMPLETED");
  if (completed.length === 0) return null;
  const latest = completed.reduce((a, b) => (a.created_on >= b.created_on ? a : b));
  const result = latest.state?.result?.name;
  return result && BB_RED.has(result) ? latest : null;
}

/** Build the Authorization header from env, or null when no credentials are set. */
export function bitbucketAuthHeader(env: NodeJS.ProcessEnv): string | null {
  if (env.BITBUCKET_TOKEN) return `Bearer ${env.BITBUCKET_TOKEN}`;
  if (env.BITBUCKET_USERNAME && env.BITBUCKET_APP_PASSWORD) {
    const basic = Buffer.from(`${env.BITBUCKET_USERNAME}:${env.BITBUCKET_APP_PASSWORD}`).toString("base64");
    return `Basic ${basic}`;
  }
  return null;
}

export const bitbucketSensor: HealthSensor = {
  id: "bitbucket-pipelines",
  async probe(_ctx, deps): Promise<HealthFinding[]> {
    const remoteRes = await deps.runCli("git", ["remote", "get-url", "origin"]);
    const slug = remoteRes.ok ? parseGitRemote(remoteRes.stdout) : null;
    if (!slug) {
      return [{
        sensor: "bitbucket-pipelines",
        source: "(no git remote)",
        status: "unknown",
        title: "Bitbucket Pipelines probe could not resolve the remote",
        detail: "git remote get-url origin failed",
      }];
    }
    const source = `${slug.host}/${slug.path}`;
    const auth = bitbucketAuthHeader(process.env);
    if (!auth) {
      return [{
        sensor: "bitbucket-pipelines",
        source,
        status: "unknown",
        title: "Bitbucket Pipelines probe skipped: no credentials",
        detail: "set BITBUCKET_TOKEN, or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD",
      }];
    }
    const url =
      `https://api.bitbucket.org/2.0/repositories/${slug.path}/pipelines/?sort=-created_on&pagelen=20`;
    const res = await deps.httpGet(url, { Authorization: auth });
    if (!res.ok) {
      return [{
        sensor: "bitbucket-pipelines",
        source,
        status: "unknown",
        title: `Bitbucket Pipelines API returned HTTP ${res.status}`,
        detail: "check the token scope (pipeline:read) / repo access",
      }];
    }
    const failed = latestFailedBitbucket(parseBitbucketPipelines(res.body));
    if (!failed) {
      return [{ sensor: "bitbucket-pipelines", source, status: "green", title: "Bitbucket Pipelines: latest run green" }];
    }
    const ref = failed.target?.ref_name ?? "?";
    return [{
      sensor: "bitbucket-pipelines",
      source,
      status: "red",
      severity: "high",
      title: `Bitbucket Pipelines failing on ${ref}`,
      detail: `pipeline #${failed.build_number ?? "?"} ${failed.state?.result?.name} (${failed.created_on})`,
      suggestedClass: "code",
    }];
  },
};
