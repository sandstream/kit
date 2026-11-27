// The live network and cooling dependencies of `kit triage release`, kept apart so tests inject
// their own. Under air-gap nothing is fetched: every lookup answers null, and the GitHub API is
// asked only through a KIT_GITHUB_API mirror.
import {
  coolingCheck,
  defaultCoolingDeps,
  enforceFrom,
  limitFrom,
  supplyChainConfig,
} from "../triage-cooling.js";
import { registryBase } from "../triage-registry.js";
import type { ReleaseAge, ReleaseDeps } from "../release-triage.js";

const MAX_TEXT = 2_000_000;

function githubHeaders(
  url: string,
  api: string | null,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": "kit-triage/1.0",
    accept: "application/vnd.github+json",
  };
  const token = (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim();
  // The token goes to the GitHub API base only, never to a download host.
  if (token && api && url.startsWith(`${api}/`)) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function get(url: string, headers: Record<string, string>): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/** The cooling verdict for a release date, with the limit and enforcement npm and pip use. */
export function releaseAge(cwd: string, env: NodeJS.ProcessEnv, now: () => number): ReleaseAge {
  return async (repo, tag, publishedAt) => {
    const cfg = await supplyChainConfig(cwd);
    const limitDays = limitFrom(cfg, env);
    const enforce = enforceFrom(cfg, env);
    const osv = { skipped: "no advisory source covers release assets" };
    const result = await coolingCheck({
      pkg: repo,
      version: tag,
      versions: [tag],
      times: { [tag]: publishedAt },
      limitDays,
      enforce,
      now: now(),
      osv,
      currentNote: "a release asset has no current version",
    });
    const days = Math.floor((now() - Date.parse(publishedAt)) / 86_400_000);
    if (result.held)
      return { status: "fail", detail: result.lines.join(" ").replace(/^\s*x CRITICAL:\s*/, "") };
    const warning = result.lines.join(" ").replace(/^\s*[!.~] (?:WARNING: |NOT CHECKED: )?/, "");
    const base = `${tag} was published ${days} days ago (cooling limit ${limitDays})`;
    return { status: "pass", detail: warning ? `${base}; ${warning}` : base };
  };
}

export async function defaultReleaseDeps(cwd: string): Promise<ReleaseDeps & { airGap: boolean }> {
  const env = process.env;
  const air = await defaultCoolingDeps.airGap(cwd);
  const api = registryBase(defaultCoolingDeps, air, "KIT_GITHUB_API", "https://api.github.com");
  return {
    airGap: air.enabled,
    githubApi: api,
    age: releaseAge(cwd, env, () => Date.now()),
    fetchText: async (url) => {
      if (air.enabled && !(api && url.startsWith(`${api}/`))) return null;
      const res = await get(url, githubHeaders(url, api, env));
      const text = res ? await res.text().catch(() => null) : null;
      return text !== null && text.length <= MAX_TEXT ? text : null;
    },
    getJson: async (url) => {
      if (air.enabled && !(api && url.startsWith(`${api}/`))) return null;
      const res = await get(url, githubHeaders(url, api, env));
      return res ? await res.json().catch(() => null) : null;
    },
  };
}
