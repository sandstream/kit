// Shared CLI helpers, extracted from cli.ts so command modules can import them
// without a circular dependency back through the entrypoint. Step 1 of splitting
// the (large) cli.ts into per-area command modules under src/commands/.
import { resolve } from "node:path";

/** The project config file name. */
export const KIT_FILE = ".kit.toml";

/** Absolute path to the project's .kit.toml in the current working directory. */
export function resolveConfigPath(): string {
  return resolve(process.cwd(), KIT_FILE);
}
