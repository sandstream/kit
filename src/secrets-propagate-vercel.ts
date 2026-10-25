/**
 * Pushing one variable to a Vercel project: through the Management API when a token and a project
 * are given, through the `vercel` CLI otherwise. A variable is created `sensitive` (write-only) for
 * production and preview, and an existing entry of another type is deleted and created again,
 * because a type cannot be changed afterwards.
 */
import type { PropagationOptions, PropagationResult } from "./secrets-propagate.js";
import { safeDiagnostic, spawnWithStdin } from "./secrets-propagate-exec.js";

type VercelEnvTarget = "production" | "preview" | "development";

interface VercelEnvVar {
  id: string;
  key: string;
  target: VercelEnvTarget[];
  /** `sensitive`, `encrypted`, `plain`, `secret` or `system`. A type cannot be changed afterwards. */
  type?: string;
}

/**
 * Vercel keeps a `sensitive` value write-only and out of the dashboard, but it allows that only for
 * Production and Preview. Development stays `encrypted`, and the result says so.
 */
/** Arguments of `vercel env add` for the CLI path. The value goes to stdin, never into argv. */
export function vercelEnvAddArgs(
  name: string,
  env: string,
  opts: Pick<PropagationOptions, "vercelScope" | "vercelCwd">,
): string[] {
  const args = ["env", "add", name, env];
  if (vercelEnvType(env) === "sensitive") args.push("--sensitive");
  if (opts.vercelScope) args.push("--scope", opts.vercelScope);
  if (opts.vercelCwd) args.push("--cwd", opts.vercelCwd);
  return args;
}

function vercelApiPath(project: string, teamId: string | undefined, suffix: string = ""): string {
  const params = new URLSearchParams();
  if (teamId) params.set("teamId", teamId);
  const query = params.toString();
  return `https://api.vercel.com/v9/projects/${encodeURIComponent(project)}/env${suffix}${query ? `?${query}` : ""}`;
}

function vercelCreateApiPath(project: string, teamId: string | undefined): string {
  const params = new URLSearchParams();
  if (teamId) params.set("teamId", teamId);
  const query = params.toString();
  return `https://api.vercel.com/v10/projects/${encodeURIComponent(project)}/env${query ? `?${query}` : ""}`;
}

async function vercelJson<T>(
  url: string,
  token: string,
  init: RequestInit = {},
  sensitiveValues: readonly string[] = [],
): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Vercel API ${res.status}: ${safeDiagnostic(text, [token, ...sensitiveValues])}`.trim(),
    );
  }
  return (await res.json()) as T;
}

async function listVercelEnvVars(
  token: string,
  project: string,
  teamId: string | undefined,
): Promise<VercelEnvVar[]> {
  const params = new URLSearchParams({ decrypt: "false" });
  if (teamId) params.set("teamId", teamId);
  const body = await vercelJson<{ envs?: VercelEnvVar[] }>(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(project)}/env?${params.toString()}`,
    token,
  );
  return body.envs ?? [];
}

export function vercelEnvType(target: string): "sensitive" | "encrypted" {
  return target === "development" ? "encrypted" : "sensitive";
}

interface Ctx {
  token: string;
  project: string;
  teamId: string | undefined;
  name: string;
  value: string;
  target: string;
  type: "sensitive" | "encrypted";
}

const outcome = (ok: boolean, detail: string): PropagationResult => ({
  target: "vercel",
  ok,
  detail,
  valueInArgv: false,
});

const devNote = (c: Ctx): string =>
  c.type === "encrypted"
    ? " (development cannot be sensitive on Vercel, so it is stored encrypted)"
    : "";

/** DELETE one entry. False on any failure, so the caller reports it instead of throwing. */
async function deleteEntry(c: Ctx, id: string): Promise<boolean> {
  try {
    const res = await fetch(vercelApiPath(c.project, c.teamId, `/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function patchValue(c: Ctx, id: string): Promise<void> {
  await vercelJson<VercelEnvVar>(
    vercelApiPath(c.project, c.teamId, `/${encodeURIComponent(id)}`),
    c.token,
    { method: "PATCH", body: JSON.stringify({ value: c.value }) },
    [c.value],
  );
}

async function createEntry(c: Ctx): Promise<void> {
  await vercelJson<VercelEnvVar>(
    vercelCreateApiPath(c.project, c.teamId),
    c.token,
    {
      method: "POST",
      body: JSON.stringify({ key: c.name, value: c.value, target: [c.target], type: c.type }),
    },
    [c.value],
  );
}

/** Delete other entries of the key that cover this target. Returns the ids that could not be deleted. */
async function deleteStale(c: Ctx, stale: readonly VercelEnvVar[]): Promise<string[]> {
  const failed: string[] = [];
  for (const entry of stale) if (!(await deleteEntry(c, entry.id))) failed.push(entry.id);
  return failed;
}

async function propagateVercelViaApi(
  name: string,
  value: string,
  opts: PropagationOptions,
): Promise<PropagationResult> {
  const token = process.env.VERCEL_TOKEN;
  const project = opts.vercelProject;
  if (!token || !project) throw new Error("missing VERCEL_TOKEN or vercelProject");
  const target = opts.env ?? "production";
  const c: Ctx = {
    token,
    project,
    teamId: opts.vercelTeamId,
    name,
    value,
    target,
    type: vercelEnvType(target),
  };

  const sameKey = (await listVercelEnvVars(token, project, c.teamId)).filter((e) => e.key === name);
  const exact = sameKey.find((e) => e.target.length === 1 && e.target[0] === target);
  if (exact && exact.type === c.type) {
    await patchValue(c, exact.id);
    return outcome(
      true,
      `pushed to vercel project=${project} env=${target} (${c.type})${devNote(c)}`,
    );
  }

  // A type cannot be changed afterwards, and a second entry for the same key and target is refused,
  // so an entry of the wrong type is deleted first and then created again. kit holds the new value,
  // so nothing is lost: a failure between the two steps is reported, and the command can be run again.
  const old = exact?.type ?? "untyped";
  if (exact && !(await deleteEntry(c, exact.id))) {
    return outcome(
      false,
      `could not delete the existing ${old} entry so it was not replaced; nothing changed`,
    );
  }
  try {
    await createEntry(c);
  } catch (err) {
    if (!exact) throw err;
    return outcome(
      false,
      `deleted the old ${old} entry for env=${target} but could not create the ${c.type} one (${safeDiagnostic(err)}); run the command again to create it`,
    );
  }

  const stale = sameKey.filter((e) => e.target.includes(target as never) && e.id !== exact?.id);
  const failed = await deleteStale(c, stale);
  if (failed.length > 0) {
    return outcome(
      false,
      `created new vercel env entry for project=${project} env=${target}, but failed to delete stale id(s): ${failed.join(", ")}`,
    );
  }
  return outcome(
    true,
    `pushed to vercel project=${project} env=${target} (${c.type})${exact ? ", replacing the old entry" : ""}${devNote(c)}`,
  );
}

export async function propagateVercel(
  name: string,
  value: string,
  opts: PropagationOptions,
): Promise<PropagationResult> {
  if (opts.vercelProject && process.env.VERCEL_TOKEN) {
    try {
      return await propagateVercelViaApi(name, value, opts);
    } catch (err) {
      return {
        target: "vercel",
        ok: false,
        detail: `vercel API failed: ${safeDiagnostic(err)}`,
        valueInArgv: false,
      };
    }
  }

  const env = opts.env ?? "production";
  // vercel env add accepts the value via stdin when invoked non-interactively
  // and printed to a stream that has no TTY.
  const args = vercelEnvAddArgs(name, env, opts);
  // Remove existing first so add doesn't error on duplicate (and so an old type is not kept).
  await spawnWithStdin(
    "vercel",
    [
      "env",
      "rm",
      name,
      env,
      "--yes",
      ...(opts.vercelScope ? ["--scope", opts.vercelScope] : []),
      ...(opts.vercelCwd ? ["--cwd", opts.vercelCwd] : []),
    ],
    "",
  );
  const { code, stderr } = await spawnWithStdin("vercel", args, value);
  return {
    target: "vercel",
    ok: code === 0,
    detail:
      code === 0 ? `pushed to vercel env=${env}` : `vercel exit ${code}: ${stderr.split("\n")[0]}`,
    valueInArgv: false,
  };
}
