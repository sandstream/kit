import type { kitConfig } from "./config.js";
import type { ExecResult } from "./utils/execFileNoThrow.js";

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
