import type { kitConfig } from "./config.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";
import { githubActionsSensor } from "./health-sensors/github-actions.js";

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
}

export interface HealthDeps {
  runCli(command: string, args: string[]): Promise<ExecResult>;
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

export const HEALTH_SENSORS: HealthSensor[] = [githubActionsSensor];

/** Returns the sensors whose underlying service the project is connected to. */
export function selectSensors(ctx: HealthCtx): HealthSensor[] {
  return HEALTH_SENSORS.filter((s) => {
    if (s.id === "github-actions") {
      return ctx.gitRemote === true || ctx.config.context?.github !== undefined;
    }
    return false;
  });
}

export const defaultHealthDeps: HealthDeps = {
  runCli: (command, args) => execFileNoThrow(command, args, { timeout: 15_000 }),
};

const MARK: Record<HealthStatus, string> = { green: "✓", red: "✗", unknown: "?" };

/** Pure human formatter — returns lines + red count (CLI adds color). */
export function formatHealth(findings: HealthFinding[]): { lines: string[]; redCount: number } {
  const lines = findings.map((f) => `${MARK[f.status]} [${f.sensor}] ${f.title}  (${f.source})`);
  const redCount = findings.filter((f) => f.status === "red").length;
  return { lines, redCount };
}
