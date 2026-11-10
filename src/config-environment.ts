import { environmentFlag } from "./utils/flags.js";

/**
 * Detect the active environment name from CLI args, env vars, or NODE_ENV.
 * Resolution order:
 *   1. --env <name> or --env=<name>, before the child separator
 *   2. KIT_ENV environment variable
 *   3. NODE_ENV (development→dev, production→prod, test→test)
 *   4. "dev" default
 */
export function resolveActiveEnvironment(cliArgs: string[] = process.argv.slice(2)): string {
  const flag = environmentFlag(cliArgs);
  if (flag.kind === "invalid") {
    throw Object.assign(new Error(flag.reason), { code: "KIT_USAGE_ERROR" });
  }
  if (flag.kind === "selected") return flag.value;

  if (process.env.KIT_ENV) return process.env.KIT_ENV;

  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv === "production") return "prod";
  if (nodeEnv === "development") return "dev";
  if (nodeEnv) return nodeEnv;

  return "dev";
}
