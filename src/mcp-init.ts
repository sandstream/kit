/** Generate the MCP kit_init result, creating .kit.toml exclusively when requested. */
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { writeFileExclusive } from "./utils/exclusive-file.js";
import { detectStack } from "./stack-detector.js";
import { generateToml } from "./toml-generator.js";
import { resolveInitServices } from "./user-defaults.js";

async function configExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function createConfig(path: string, content: string): Promise<boolean> {
  try {
    await writeFileExclusive(path, content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export async function generateMcpInit(cwd?: string, dryRun?: boolean) {
  const workDir = cwd ?? process.cwd();
  const cfgPath = resolve(workDir, ".kit.toml");
  // Known services are offered as a gap; only detected services enter generated config.
  const detected = await detectStack(workDir);
  const {
    stack,
    offered: offeredServices,
    applied: appliedDefaults,
    unknown: unknownDefaults,
  } = resolveInitServices(detected);
  const { toml: generatedConfig, gaps: configGaps } = generateToml(stack);
  const gaps = offeredServices.length
    ? [
        {
          path: "services",
          owner: "agent" as const,
          why: "known services that nothing in this repo references",
          candidates: offeredServices,
          fix: `kit init --services ${[...stack.services, ...offeredServices].join(",")}`,
        },
        ...configGaps,
      ]
    : configGaps;

  const written = dryRun ? false : await createConfig(cfgPath, generatedConfig);
  const alreadyExists = dryRun ? await configExists(cfgPath) : !written;
  return {
    detectedStack: stack,
    appliedDefaults,
    unknownDefaults,
    generatedConfig,
    gaps,
    written,
    alreadyExists,
    message: alreadyExists
      ? ".kit.toml already exists — not overwritten"
      : dryRun
        ? "dry_run=true, config not written"
        : ".kit.toml generated successfully",
  };
}
