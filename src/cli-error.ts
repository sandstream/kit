import { hasFlag } from "./utils/flags.js";
import { redactSecrets, secretValuesFromEnv } from "./utils/redactSecrets.js";
import { c } from "./utils/colors.js";

/** Last-resort CLI error path, including rejections before command dispatch. */
export function reportUnexpectedCliError(
  err: unknown,
  args: readonly string[] = process.argv.slice(2),
): void {
  const raw = err instanceof Error ? err.message : String(err);
  const message = redactSecrets(raw, secretValuesFromEnv(process.env));
  if (hasFlag(args, "--json")) console.log(JSON.stringify({ ok: false, error: message }));
  console.error(`${c.red}Error: ${message}${c.reset}`);
  process.exitCode = 1;
}
