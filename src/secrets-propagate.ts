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
 */

import { spawn } from "node:child_process";

export type PropagationTarget =
  | "vercel"
  | "github"
  | "fly"
  | "cloudflare"
  | "railway"
  | "aws-ssm";

export const ALL_TARGETS: PropagationTarget[] = [
  "vercel",
  "github",
  "fly",
  "cloudflare",
  "railway",
  "aws-ssm",
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
  /** Vercel scope (team or user). */
  vercelScope?: string;
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
}

/**
 * Spawns a CLI with the value piped via stdin. Returns the exit code +
 * captured stderr for diagnostics. The value never appears in argv.
 */
async function spawnWithStdin(
  cmd: string,
  args: string[],
  stdinValue: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolve({ code: 127, stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr });
    });
    child.stdin.write(stdinValue);
    child.stdin.end();
  });
}

async function propagateVercel(
  name: string,
  value: string,
  opts: PropagationOptions,
): Promise<PropagationResult> {
  const env = opts.env ?? "production";
  // vercel env add accepts the value via stdin when invoked non-interactively
  // and printed to a stream that has no TTY.
  const args = ["env", "add", name, env];
  if (opts.vercelScope) args.push("--scope", opts.vercelScope);
  // Remove existing first so add doesn't error on duplicate.
  await spawnWithStdin("vercel", ["env", "rm", name, env, "--yes", ...(opts.vercelScope ? ["--scope", opts.vercelScope] : [])], "");
  const { code, stderr } = await spawnWithStdin("vercel", args, value);
  return {
    target: "vercel",
    ok: code === 0,
    detail: code === 0 ? `pushed to vercel env=${env}` : `vercel exit ${code}: ${stderr.split("\n")[0]}`,
    valueInArgv: false,
  };
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
  );
  return {
    target: "fly",
    ok: code === 0,
    detail: code === 0 ? `pushed to fly app=${opts.flyApp}` : `fly exit ${code}: ${stderr.split("\n")[0]}`,
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
    detail: code === 0 ? `pushed to cloudflare worker=${opts.cfWorker}` : `wrangler exit ${code}: ${stderr.split("\n")[0]}`,
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
  const { code, stderr } = await spawnWithStdin("railway", args, "");
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
    detail: code === 0 ? `pushed to aws-ssm path=${paramName}` : `aws exit ${code}: ${stderr.split("\n")[0]}`,
    valueInArgv: false,
  };
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
};

export async function propagate(
  name: string,
  value: string,
  targets: PropagationTarget[],
  opts: PropagationOptions = {},
): Promise<PropagationResult[]> {
  const results: PropagationResult[] = [];
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
    try {
      results.push(await adapter(name, value, opts));
    } catch (err: unknown) {
      results.push({
        target: t,
        ok: false,
        detail: err instanceof Error ? err.message.split("\n")[0] : String(err),
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
