import { resolve } from "node:path";
import type {
  DeployConfig,
  DeployEnvironmentConfig,
  DeployVercelConfig,
  VercelDeployEnvironment,
} from "./config.js";
import { execFileNoThrow } from "./utils/exec.js";
import { resolveToolBin } from "./utils/resolveTool.js";

export type DeployCheckStatus = "pass" | "fail" | "warn" | "skip";
export type DeployCheckProvider = "deploy" | "vercel";

export interface DeployCheckResult {
  provider: DeployCheckProvider;
  environment: string;
  project: string;
  status: DeployCheckStatus;
  detail: string;
  missing?: string[];
  drift?: string[];
  buildTime?: string[];
  didNotRun?: boolean;
  remoteEnv?: VercelDeployEnvironment;
  cwd?: string;
}

export interface VercelDeployTarget {
  provider: "vercel";
  environment: string;
  project: string;
  required: string[];
  buildTime: string[];
  environmentSpecific: string[];
  remoteEnv?: VercelDeployEnvironment;
  teamId?: string;
  scope?: string;
  cwd: string;
}

export interface DeployListResult {
  ok: boolean;
  names: string[];
  detail: string;
  didNotRun?: boolean;
}

export type DeployListEnv = (target: VercelDeployTarget) => Promise<DeployListResult>;

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const VERCEL_ENVS = new Set(["production", "preview", "development"]);

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function cleanLine(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

function firstLine(value: string): string {
  return cleanLine(value).split("\n").map(cleanLine).find(Boolean) ?? "no output";
}

function isEnvName(value: unknown): value is string {
  return typeof value === "string" && ENV_NAME_RE.test(value);
}

function collectJsonEnvNames(value: unknown, names: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonEnvNames(item, names);
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  for (const field of ["key", "name"]) {
    const candidate = record[field];
    if (isEnvName(candidate)) names.add(candidate);
  }
  for (const field of ["data", "envs", "environmentVariables", "variables"]) {
    collectJsonEnvNames(record[field], names);
  }
}

function isVercelEnvTarget(value: unknown): value is VercelDeployEnvironment {
  return typeof value === "string" && VERCEL_ENVS.has(value);
}

function envTargets(value: unknown): VercelDeployEnvironment[] {
  if (Array.isArray(value)) return value.filter(isVercelEnvTarget);
  return isVercelEnvTarget(value) ? [value] : [];
}

function collectVercelApiEnvNames(
  value: unknown,
  remoteEnv: VercelDeployEnvironment | undefined,
): string[] {
  const names = new Set<string>();
  const envs =
    value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).envs)
      ? ((value as Record<string, unknown>).envs as unknown[])
      : Array.isArray(value)
        ? value
        : [];

  for (const item of envs) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const key = record.key;
    if (!isEnvName(key)) continue;
    const targets = envTargets(record.target);
    if (!remoteEnv || targets.length === 0 || targets.includes(remoteEnv)) names.add(key);
  }
  return uniqueSorted(names);
}

export function parseVercelEnvNames(output: string): string[] {
  const names = new Set<string>();
  const trimmed = output.trim();

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      collectJsonEnvNames(JSON.parse(trimmed), names);
    } catch {
      // Fall through to table parsing; old CLIs may ignore --format json.
    }
  }

  if (names.size === 0) {
    for (const rawLine of output.split("\n")) {
      const line = cleanLine(rawLine);
      if (!line || line.startsWith(">") || line.startsWith("Vercel CLI")) continue;
      const first = line.split(/\s+/)[0];
      if (isEnvName(first)) names.add(first);
    }
  }

  return uniqueSorted(names);
}

export function inferVercelRemoteEnv(logicalEnv: string): VercelDeployEnvironment | null {
  if (VERCEL_ENVS.has(logicalEnv)) return logicalEnv as VercelDeployEnvironment;
  if (logicalEnv === "prod") return "production";
  if (logicalEnv === "dev") return "development";
  return null;
}

function requiredKeys(envConfig: DeployEnvironmentConfig): string[] {
  return uniqueSorted(envConfig.required ?? []);
}

function buildTimeKeys(
  providerConfig: DeployVercelConfig,
  envConfig: DeployEnvironmentConfig,
): string[] {
  const required = requiredKeys(envConfig);
  return uniqueSorted([
    ...required.filter((name) => name.startsWith("NEXT_PUBLIC_")),
    ...(providerConfig.build_time ?? []),
    ...(envConfig.build_time ?? []),
  ]);
}

export function buildVercelDeployTargets(
  config: DeployVercelConfig,
  cwd: string,
): VercelDeployTarget[] {
  const environments = config.environments ?? {};
  return Object.entries(environments).map(([environment, envConfig]) => {
    const envCwd = envConfig.cwd ? resolve(cwd, envConfig.cwd) : cwd;
    const remoteEnv = envConfig.remote_env ?? inferVercelRemoteEnv(environment) ?? undefined;
    return {
      provider: "vercel",
      environment,
      project: envConfig.project,
      required: requiredKeys(envConfig),
      buildTime: buildTimeKeys(config, envConfig),
      environmentSpecific: uniqueSorted([
        ...(config.environment_specific ?? []),
        ...(envConfig.environment_specific ?? []),
      ]),
      remoteEnv,
      teamId: config.team_id,
      scope: config.scope,
      cwd: envCwd,
    };
  });
}

async function listVercelEnvNamesViaApi(target: VercelDeployTarget): Promise<DeployListResult> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    return {
      ok: false,
      names: [],
      detail: "VERCEL_TOKEN not set",
      didNotRun: true,
    };
  }

  const params = new URLSearchParams({ decrypt: "false" });
  if (target.teamId) params.set("teamId", target.teamId);
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(target.project)}/env?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      ok: false,
      names: [],
      detail: `vercel API env list failed: ${err instanceof Error ? err.message : String(err)}`,
      didNotRun: true,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      names: [],
      detail: `vercel API env list failed: ${res.status} ${firstLine(await res.text())}`,
      didNotRun: true,
    };
  }

  try {
    return {
      ok: true,
      names: collectVercelApiEnvNames(await res.json(), target.remoteEnv),
      detail: "listed remote key names via Vercel API",
    };
  } catch (err) {
    return {
      ok: false,
      names: [],
      detail: `vercel API env list returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      didNotRun: true,
    };
  }
}

async function listVercelEnvNames(target: VercelDeployTarget): Promise<DeployListResult> {
  if (process.env.VERCEL_TOKEN) return listVercelEnvNamesViaApi(target);

  const bin = (await resolveToolBin("vercel")) ?? "vercel";
  const args = ["env", "ls"];
  if (target.remoteEnv) args.push(target.remoteEnv);
  args.push("--format", "json", "--no-color");
  if (target.scope) args.push("--scope", target.scope);
  args.push("--cwd", target.cwd);

  const result = await execFileNoThrow(bin, args, {
    cwd: target.cwd,
    timeout: 20_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (!result.ok) {
    return {
      ok: false,
      names: [],
      detail: `vercel env ls failed: ${firstLine(result.stderr || result.stdout)}`,
      didNotRun: true,
    };
  }
  return {
    ok: true,
    names: parseVercelEnvNames(result.stdout),
    detail: "listed remote key names",
  };
}

function formatNames(names: string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function noDeployConfigured(): DeployCheckResult {
  return {
    provider: "deploy",
    environment: "-",
    project: "-",
    status: "skip",
    detail:
      "No [deploy] configured. Declare [deploy.vercel.environments.<env>] with project + required key names to check remote deploy env.",
  };
}

async function checkVercelDeploy(
  config: DeployVercelConfig,
  cwd: string,
  listEnv: DeployListEnv,
): Promise<DeployCheckResult[]> {
  const targets = buildVercelDeployTargets(config, cwd);
  if (targets.length === 0) {
    return [
      {
        provider: "vercel",
        environment: "-",
        project: "-",
        status: "skip",
        detail:
          "No [deploy.vercel.environments] configured. Add one table per deploy target with project + required key names.",
      },
    ];
  }

  const remoteNames = new Map<string, Set<string>>();
  const results: DeployCheckResult[] = [];

  for (const target of targets) {
    const listed = await listEnv(target);
    if (!listed.ok) {
      results.push({
        provider: "vercel",
        environment: target.environment,
        project: target.project,
        status: "fail",
        detail: listed.detail,
        didNotRun: listed.didNotRun,
        remoteEnv: target.remoteEnv,
        cwd: target.cwd,
      });
      continue;
    }

    const names = new Set(listed.names);
    remoteNames.set(target.environment, names);
    const missing = target.required.filter((name) => !names.has(name));
    const buildTime = missing.filter((name) => target.buildTime.includes(name));
    const detail =
      missing.length > 0
        ? `missing required key name(s): ${formatNames(missing)}${
            buildTime.length > 0
              ? `; build-time key(s) require redeploy after setting: ${formatNames(buildTime)}`
              : ""
          }`
        : target.required.length > 0
          ? `all ${target.required.length} required key name(s) present`
          : "no required key names declared for this environment";

    results.push({
      provider: "vercel",
      environment: target.environment,
      project: target.project,
      status: missing.length > 0 ? "fail" : "pass",
      detail,
      ...(missing.length > 0 ? { missing } : {}),
      ...(buildTime.length > 0 ? { buildTime } : {}),
      remoteEnv: target.remoteEnv,
      cwd: target.cwd,
    });
  }

  const listedTargets = targets.filter((target) => remoteNames.has(target.environment));
  if (listedTargets.length >= 2) {
    const allNames = uniqueSorted(
      listedTargets.flatMap((target) => [...(remoteNames.get(target.environment) ?? [])]),
    );
    const driftExempt = new Set(listedTargets.flatMap((target) => target.environmentSpecific));

    for (const target of listedTargets) {
      const present = remoteNames.get(target.environment) ?? new Set<string>();
      const drift = allNames.filter((name) => !present.has(name) && !driftExempt.has(name));
      if (drift.length === 0) continue;
      const row = results.find(
        (result) => result.provider === "vercel" && result.environment === target.environment,
      );
      if (!row) continue;
      row.drift = drift;
      if (row.status === "pass") row.status = "warn";
      row.detail = `${row.detail}; drift: remote key name(s) present in another deploy target but missing here: ${formatNames(drift)}`;
    }
  }

  return results;
}

export async function checkDeploy(
  config: DeployConfig | undefined,
  cwd: string = process.cwd(),
  opts: { listVercelEnvNames?: DeployListEnv } = {},
): Promise<DeployCheckResult[]> {
  if (!config || Object.keys(config).length === 0) return [noDeployConfigured()];

  const results: DeployCheckResult[] = [];
  if (config.vercel) {
    results.push(
      ...(await checkVercelDeploy(
        config.vercel,
        cwd,
        opts.listVercelEnvNames ?? listVercelEnvNames,
      )),
    );
  }

  return results.length > 0 ? results : [noDeployConfigured()];
}
