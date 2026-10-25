/**
 * Push a credential value to one or more deploy-platform secret stores.
 *
 * Used by `kit secrets rotate --propagate <targets>` so a rotated key
 * lands in every place the running service reads it from, not just the
 * upstream vault. Each adapter shells out to the platform's official CLI;
 * the value is piped via stdin where the CLI supports it to keep it out of
 * argv / process listings.
 *
 * Targets implemented:
 *   - vercel       `vercel env add <name> <env>` (stdin)
 *   - github       `gh secret set <name>` (stdin)
 *   - fly          `fly secrets set <name>=<value> --stage` (argv — Fly has
 *                  no stdin path; documented as a known leak surface)
 *   - cloudflare   `wrangler secret put <name>` (stdin)
 *   - railway      `railway variables --set <name>=<value>` (argv)
 *   - aws-ssm      `aws ssm put-parameter --name <key> --value file:///dev/stdin
 *                  --type SecureString --overwrite` (stdin via --value file://)
 *   - supabase     `supabase secrets set --env-file <private file>` (Edge Function
 *                  secrets; Supabase's CLI has no stdin path, so the value goes in a
 *                  0600 file inside a 0700 folder that is removed afterwards)
 */

import type { PolicyConfig } from "./config.js";
import { enforcePolicy } from "./policy-gate.js";
import { flagValue } from "./utils/flags.js";
import { propagateSupabase } from "./secrets-propagate-supabase.js";
import { propagateVercel } from "./secrets-propagate-vercel.js";
import { safeDiagnostic, spawnWithStdin } from "./secrets-propagate-exec.js";

export type PropagationTarget =
  | "vercel"
  | "github"
  | "fly"
  | "cloudflare"
  | "railway"
  | "aws-ssm"
  | "supabase";

export const ALL_TARGETS: PropagationTarget[] = [
  "vercel",
  "github",
  "fly",
  "cloudflare",
  "railway",
  "aws-ssm",
  "supabase",
];

export interface PropagationResult {
  target: PropagationTarget;
  ok: boolean;
  detail: string;
  /** True if the value passed through argv at any point (informational). */
  valueInArgv: boolean;
}

export interface PropagationOptions {
  /** Logical env to write into (Vercel: "production"|"preview"|"development"). */
  env?: "production" | "preview" | "development";
  /** Supabase project ref for Edge Function secrets. Omitted: the project linked in the working folder. */
  supabaseProject?: string;
  /** Vercel scope (team or user). */
  vercelScope?: string;
  /** Vercel project name/id for Management API writes. */
  vercelProject?: string;
  /** Vercel team id for Management API writes. */
  vercelTeamId?: string;
  /** Vercel project directory to use for env writes when a monorepo has multiple links. */
  vercelCwd?: string;
  /** GitHub repo (owner/name). Inferred from `gh repo view` when omitted. */
  githubRepo?: string;
  /** Fly app name. Required for fly. */
  flyApp?: string;
  /** Cloudflare worker name. Required for cloudflare. */
  cfWorker?: string;
  /** Railway service id. */
  railwayService?: string;
  /** AWS region for SSM. */
  awsRegion?: string;
  /** Optional override path prefix for SSM (default: `/kit/`). */
  awsSsmPrefix?: string;
  /**
   * `[policy]` from the project's `.kit.toml`. When present, every target is checked against
   * `[policy.agent_writes.<target>]` for the `env_set` op BEFORE its adapter runs.
   *
   * The check lives inside `propagate` rather than at each call site on purpose: this function is
   * the single choke point for all six vendor env writes, so a caller that forgets to pass a
   * context cannot route around the gate. Omitting `policy` leaves behaviour identical to before —
   * the gate is opt-in by the presence of the config block, not by the caller remembering.
   */
  policy?: PolicyConfig;
  /**
   * Project directory the policy audit entry belongs to. Defaults to `process.cwd()`, which is
   * correct for both CLI callers; it exists because a governed operation's evidence must land in
   * the project it was performed for, not in whatever directory the process happens to occupy.
   */
  cwd?: string;
}

async function propagateGithub(
  name: string,
  value: string,
  opts: PropagationOptions,
): Promise<PropagationResult> {
  const args = ["secret", "set", name];
  if (opts.githubRepo) args.push("--repo", opts.githubRepo);
  if (opts.env === "production") args.push("--env", "production");
  if (opts.env === "preview") args.push("--env", "preview");
  // gh secret set reads value from stdin when --body is not provided.
  const { code, stderr } = await spawnWithStdin("gh", args, value);
  return {
    target: "github",
    ok: code === 0,
    detail: code === 0 ? `pushed to github secrets` : `gh exit ${code}: ${stderr.split("\n")[0]}`,
    valueInArgv: false,
  };
}

async function propagateFly(
  name: string,
  value: string,
  opts: PropagationOptions,
): Promise<PropagationResult> {
  if (!opts.flyApp) {
    return {
      target: "fly",
      ok: false,
      detail: "fly: --fly-app <name> required",
      valueInArgv: false,
    };
  }
  // `fly secrets set` reads KEY=VALUE pairs from argv; no stdin path.
  // Value is visible in `ps` for the duration of the call.
  const { code, stderr } = await spawnWithStdin(
    "fly",
    ["secrets", "set", `${name}=${value}`, "--app", opts.flyApp, "--stage"],
    "",
    [value],
  );
  return {
    target: "fly",
    ok: code === 0,
    detail:
      code === 0
        ? `pushed to fly app=${opts.flyApp}`
        : `fly exit ${code}: ${stderr.split("\n")[0]}`,
    valueInArgv: true,
  };
}

async function propagateCloudflare(
  name: string,
  value: string,
  opts: PropagationOptions,
): Promise<PropagationResult> {
  if (!opts.cfWorker) {
    return {
      target: "cloudflare",
      ok: false,
      detail: "cloudflare: --cf-worker <name> required",
      valueInArgv: false,
    };
  }
  const { code, stderr } = await spawnWithStdin(
    "wrangler",
    ["secret", "put", name, "--name", opts.cfWorker],
    value,
  );
  return {
    target: "cloudflare",
    ok: code === 0,
    detail:
      code === 0
        ? `pushed to cloudflare worker=${opts.cfWorker}`
        : `wrangler exit ${code}: ${stderr.split("\n")[0]}`,
    valueInArgv: false,
  };
}

async function propagateRailway(
  name: string,
  value: string,
  opts: PropagationOptions,
): Promise<PropagationResult> {
  // `railway variables --set KEY=VALUE` — value in argv (no stdin path).
  const args = ["variables", "--set", `${name}=${value}`];
  if (opts.railwayService) args.push("--service", opts.railwayService);
  const { code, stderr } = await spawnWithStdin("railway", args, "", [value]);
  return {
    target: "railway",
    ok: code === 0,
    detail: code === 0 ? `pushed to railway` : `railway exit ${code}: ${stderr.split("\n")[0]}`,
    valueInArgv: true,
  };
}

async function propagateAwsSsm(
  name: string,
  value: string,
  opts: PropagationOptions,
): Promise<PropagationResult> {
  const prefix = opts.awsSsmPrefix ?? "/kit/";
  const paramName = `${prefix}${name}`.replace(/\/+/g, "/");
  // `aws ssm put-parameter --value file:///dev/stdin` reads the value from
  // stdin instead of argv.
  const args = [
    "ssm",
    "put-parameter",
    "--name",
    paramName,
    "--value",
    "file:///dev/stdin",
    "--type",
    "SecureString",
    "--overwrite",
  ];
  if (opts.awsRegion) args.push("--region", opts.awsRegion);
  const { code, stderr } = await spawnWithStdin("aws", args, value);
  return {
    target: "aws-ssm",
    ok: code === 0,
    detail:
      code === 0
        ? `pushed to aws-ssm path=${paramName}`
        : `aws exit ${code}: ${stderr.split("\n")[0]}`,
    valueInArgv: false,
  };
}

/** The platform flags shared by `kit secrets propagate` and `kit secrets rotate --propagate`. */
export function propagationOptionsFromArgs(args: readonly string[]): PropagationOptions {
  const o: PropagationOptions = {};
  // Each flag is named in a literal flagValue call: the flag-surface scan finds flags there, and a
  // helper that takes the flag as an argument hides it, so `kit secrets` would refuse it.
  const set = <K extends keyof PropagationOptions>(key: K, v: string | undefined) => {
    if (v !== undefined) o[key] = v as PropagationOptions[K];
  };
  set("env", flagValue(args, "--target-env"));
  set("vercelProject", flagValue(args, "--vercel-project"));
  set("vercelTeamId", flagValue(args, "--vercel-team"));
  set("vercelScope", flagValue(args, "--vercel-scope"));
  set("supabaseProject", flagValue(args, "--supabase-project"));
  set("flyApp", flagValue(args, "--fly-app"));
  set("cfWorker", flagValue(args, "--cf-worker"));
  set("railwayService", flagValue(args, "--railway-service"));
  set("awsRegion", flagValue(args, "--aws-region"));
  set("githubRepo", flagValue(args, "--github-repo"));
  return o;
}

const ADAPTERS: Record<
  PropagationTarget,
  (name: string, value: string, opts: PropagationOptions) => Promise<PropagationResult>
> = {
  vercel: propagateVercel,
  github: propagateGithub,
  fly: propagateFly,
  cloudflare: propagateCloudflare,
  railway: propagateRailway,
  "aws-ssm": propagateAwsSsm,
  supabase: propagateSupabase,
};

export async function propagate(
  name: string,
  value: string,
  targets: PropagationTarget[],
  opts: PropagationOptions = {},
): Promise<PropagationResult[]> {
  const results: PropagationResult[] = [];

  // READ-ONLY MODE. Propagation writes a secret into a third-party control plane, which is about
  // as far from read-only as an operation gets — and nothing was stopping it.
  //
  // Measured before adding this: with elevation satisfied (`KIT_ELEVATED=1`), `KIT_READ_ONLY=1`
  // `kit secrets propagate API_KEY --value x --to vercel` reached `spawn vercel` and failed only
  // because the CLI is absent from the probe machine. With the CLI present it would have written.
  //
  // `read-only-surface.ts` deliberately omits `secrets`, on the stated grounds that it is "already
  // refused inside their own modules". That was true of the LOCAL secret write —
  // `writeSecretToBackend` calls `refuseWrite` — and false of this one. Propagation is a different
  // write in the same module, and "the module handles it" was a claim about one path read as a
  // claim about all of them.
  //
  // Checked once rather than per target (the lock is session-wide, not per vendor), but reported as
  // a row per requested target so the operator sees exactly what did not happen.
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite(
      "secrets-propagate",
      { key: name, targets },
      { cwd: opts.cwd },
    );
    return targets.map((t) => ({
      target: t,
      ok: false,
      detail: refusal.reason,
      valueInArgv: false,
    }));
  }

  for (const t of targets) {
    const adapter = ADAPTERS[t];
    if (!adapter) {
      results.push({
        target: t,
        ok: false,
        detail: `unknown target: ${t}`,
        valueInArgv: false,
      });
      continue;
    }
    // `[policy.agent_writes]` — narrowing only. A refusal stops the adapter from ever running;
    // an approval grants NOTHING (elevation, read-only and approval stay authoritative), which is
    // why there is no `approved` branch here. The refusal is reported as a normal failed result so
    // it shows up in the same output the operator already reads, rather than as an exception.
    const refusal = await enforcePolicy(opts.policy, t, "env_set", { cwd: opts.cwd });
    if (refusal) {
      results.push({
        target: t,
        ok: false,
        detail: `refused by [policy.agent_writes]: ${refusal.reason}`,
        valueInArgv: false,
      });
      continue;
    }
    try {
      results.push(await adapter(name, value, opts));
    } catch (err: unknown) {
      results.push({
        target: t,
        ok: false,
        detail: safeDiagnostic(err),
        valueInArgv: false,
      });
    }
  }
  return results;
}

export function parseTargets(spec: string): PropagationTarget[] {
  const known = new Set(ALL_TARGETS);
  return spec
    .split(",")
    .map((t) => t.trim())
    .filter((t): t is PropagationTarget => known.has(t as PropagationTarget));
}

export { vercelEnvAddArgs } from "./secrets-propagate-vercel.js";
export {
  isValidSupabaseSecretName,
  quoteEnvValue,
  writePrivateEnvFile,
} from "./secrets-propagate-supabase.js";
