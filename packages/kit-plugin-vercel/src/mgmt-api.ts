/**
 * Minimal Vercel Management API client.
 *
 * Auth: `VERCEL_TOKEN` env var (create via
 * https://vercel.com/account/tokens). For team-scoped operations also
 * pass `--team-id <id>` or set `VERCEL_TEAM_ID`.
 *
 * Implemented:
 *   GET    /v9/projects                     list projects
 *   GET    /v9/projects/{idOrName}          project metadata
 *   GET    /v9/projects/{idOrName}/env      list env vars
 *   POST   /v10/projects/{idOrName}/env     create env var
 *   DELETE /v9/projects/{idOrName}/env/{id} delete env var
 *   POST   /v13/deployments                 trigger new deployment (redeploy)
 *
 * The existing `propagate` adapter in core kit already wraps
 * `vercel env add` via the CLI. This module gives the API-level path for
 * teams that prefer not to depend on the Vercel CLI on the runner.
 */

const DEFAULT_BASE_URL = "https://api.vercel.com";

function assertNotReadOnly(operation: string): void {
  const v = process.env.KIT_READ_ONLY;
  if (v === "1" || v === "true") {
    throw new Error(`read-only mode active — refusing "${operation}"`);
  }
}

export interface MgmtClientConfig {
  baseUrl?: string;
  token?: string;
  teamId?: string;
}

export interface MgmtClient {
  baseUrl: string;
  headers: HeadersInit;
  /** Appended to every query string when set. */
  teamQuery: string;
}

export function makeClient(cfg: MgmtClientConfig = {}): MgmtClient {
  const token = cfg.token ?? process.env.VERCEL_TOKEN;
  if (!token) {
    throw new Error("VERCEL_TOKEN not set — generate one at https://vercel.com/account/tokens");
  }
  const teamId = cfg.teamId ?? process.env.VERCEL_TEAM_ID;
  return {
    baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    teamQuery: teamId ? `?teamId=${encodeURIComponent(teamId)}` : "",
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  framework?: string | null;
  accountId: string;
  createdAt?: number;
  latestDeployments?: { id: string; url: string; readyState?: string }[];
}

export async function listProjects(client: MgmtClient): Promise<ProjectSummary[]> {
  const res = await fetch(`${client.baseUrl}/v9/projects${client.teamQuery}`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`/v9/projects returned ${res.status}: ${await safeText(res)}`);
  }
  const body = (await res.json()) as { projects: ProjectSummary[] };
  return body.projects ?? [];
}

export type VercelEnvTarget = "production" | "preview" | "development";

export interface EnvVar {
  id: string;
  key: string;
  value?: string;
  target: VercelEnvTarget[];
  type?: "plain" | "secret" | "encrypted" | "system";
}

export async function listEnvVars(client: MgmtClient, projectIdOrName: string): Promise<EnvVar[]> {
  const sep = client.teamQuery ? "&" : "?";
  const res = await fetch(
    `${client.baseUrl}/v9/projects/${encodeURIComponent(projectIdOrName)}/env${client.teamQuery}${sep}decrypt=false`,
    { headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    throw new Error(
      `/v9/projects/${projectIdOrName}/env returned ${res.status}: ${await safeText(res)}`,
    );
  }
  const body = (await res.json()) as { envs: EnvVar[] };
  return body.envs ?? [];
}

export async function createEnvVar(
  client: MgmtClient,
  projectIdOrName: string,
  entry: { key: string; value: string; target: VercelEnvTarget[]; type?: "encrypted" | "plain" },
): Promise<EnvVar> {
  assertNotReadOnly("vercel/createEnvVar");
  const res = await fetch(
    `${client.baseUrl}/v10/projects/${encodeURIComponent(projectIdOrName)}/env${client.teamQuery}`,
    {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({
        key: entry.key,
        value: entry.value,
        target: entry.target,
        type: entry.type ?? "encrypted",
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    throw new Error(`POST env returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as EnvVar;
}

export async function deleteEnvVar(
  client: MgmtClient,
  projectIdOrName: string,
  envId: string,
): Promise<void> {
  assertNotReadOnly("vercel/deleteEnvVar");
  const res = await fetch(
    `${client.baseUrl}/v9/projects/${encodeURIComponent(projectIdOrName)}/env/${encodeURIComponent(envId)}${client.teamQuery}`,
    { method: "DELETE", headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    throw new Error(`DELETE env returned ${res.status}: ${await safeText(res)}`);
  }
}

/**
 * In-place update of an existing env var (atomic on Vercel's side). Used
 * by `upsertEnvVar` when a single existing entry covers the requested
 * targets exactly — avoids the delete-then-create race that the old
 * upsert implementation had (mid-failure left the key absent).
 */
export async function updateEnvVar(
  client: MgmtClient,
  projectIdOrName: string,
  envId: string,
  patch: { value?: string; target?: VercelEnvTarget[]; type?: "encrypted" | "plain" },
): Promise<EnvVar> {
  assertNotReadOnly("vercel/updateEnvVar");
  const res = await fetch(
    `${client.baseUrl}/v9/projects/${encodeURIComponent(projectIdOrName)}/env/${encodeURIComponent(envId)}${client.teamQuery}`,
    {
      method: "PATCH",
      headers: client.headers,
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    throw new Error(`PATCH env returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as EnvVar;
}

function targetsMatch(a: VercelEnvTarget[], b: VercelEnvTarget[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((t) => setB.has(t));
}

/**
 * Upserts an env var across the requested targets. Atomicity strategy:
 *
 *   1. If exactly one existing entry matches the same (key, target-set):
 *      PATCH it in place — single request, no window where the key is
 *      absent.
 *   2. Otherwise (key absent, or partial-target overlap requires a new
 *      shape): CREATE the new entry first, then DELETE the conflicting
 *      old ones. If CREATE fails, the old values stay live; if DELETE
 *      fails after a successful CREATE, the new entry is live and the
 *      function logs the stale-old-id list so the operator can clean up.
 *
 * The previous implementation deleted-then-created, leaving a window where
 * the key was missing from the project — a transient failure mid-window
 * meant the env var disappeared until the operator retried.
 */
export async function upsertEnvVar(
  client: MgmtClient,
  projectIdOrName: string,
  entry: { key: string; value: string; target: VercelEnvTarget[] },
): Promise<EnvVar> {
  const existing = await listEnvVars(client, projectIdOrName);
  const sameKey = existing.filter((e) => e.key === entry.key);

  // Fast path: exact match → PATCH (atomic).
  if (sameKey.length === 1 && targetsMatch(sameKey[0]!.target, entry.target)) {
    return updateEnvVar(client, projectIdOrName, sameKey[0]!.id, {
      value: entry.value,
    });
  }

  // Identify conflicting entries (same key + overlapping target).
  const conflicts = sameKey.filter((e) => e.target.some((t) => entry.target.includes(t)));

  if (conflicts.length === 0) {
    // Pure create — no conflict, no race window.
    return createEnvVar(client, projectIdOrName, entry);
  }

  // Conflict path: create-then-delete. Old entries stay live until the
  // new one is confirmed. Vercel allows multiple entries with the same
  // key as long as their target sets don't overlap; the conflicting
  // entries below DO overlap, so we delete them — but only after the
  // new entry is in.
  const created = await createEnvVar(client, projectIdOrName, entry);
  const staleIds: string[] = [];
  for (const stale of conflicts) {
    try {
      await deleteEnvVar(client, projectIdOrName, stale.id);
    } catch (err) {
      staleIds.push(stale.id);
      console.error(
        `Vercel upsert: created new entry but failed to delete stale id=${stale.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (staleIds.length > 0) {
    console.error(
      `Vercel upsert: ${staleIds.length} stale entr(y/ies) remain. Clean up manually: ${staleIds.join(", ")}`,
    );
  }
  return created;
}

export interface RedeployResult {
  id: string;
  url: string;
  readyState?: string;
}

/**
 * Triggers a redeploy of the most recent production deployment so a new
 * env value takes effect without waiting for the next git push. Vercel's
 * `/v13/deployments` accepts a deploymentId to clone.
 */
export async function redeployLatest(
  client: MgmtClient,
  projectIdOrName: string,
  opts: { target?: VercelEnvTarget; name?: string } = {},
): Promise<RedeployResult> {
  assertNotReadOnly("vercel/redeployLatest");
  // Find the latest deployment for the project.
  const sep = client.teamQuery ? "&" : "?";
  const listRes = await fetch(
    `${client.baseUrl}/v6/deployments${client.teamQuery}${sep}projectId=${encodeURIComponent(projectIdOrName)}&limit=1&target=${opts.target ?? "production"}`,
    { headers: client.headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!listRes.ok) {
    throw new Error(`/v6/deployments returned ${listRes.status}: ${await safeText(listRes)}`);
  }
  const listBody = (await listRes.json()) as { deployments?: { uid: string; name?: string }[] };
  const last = listBody.deployments?.[0];
  if (!last) {
    throw new Error(`No prior deployments for project ${projectIdOrName} — push first.`);
  }

  // Trigger a redeploy by cloning the last deployment.
  const res = await fetch(`${client.baseUrl}/v13/deployments${client.teamQuery}`, {
    method: "POST",
    headers: client.headers,
    body: JSON.stringify({
      name: opts.name ?? last.name ?? projectIdOrName,
      deploymentId: last.uid,
      target: opts.target ?? "production",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`POST /v13/deployments returned ${res.status}: ${await safeText(res)}`);
  }
  const body = (await res.json()) as { id: string; url: string; readyState?: string };
  return { id: body.id, url: body.url, readyState: body.readyState };
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return "<no body>";
  }
}
