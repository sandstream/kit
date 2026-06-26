// `kit sbom` command — extracted from cli.ts (incremental split).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { flagValue } from "../utils/flags.js";

export async function cmdSbom(): Promise<boolean> {
  const fmt = (flagValue(process.argv, "--format") ?? "cyclonedx").toLowerCase();
  if (fmt !== "cyclonedx" && fmt !== "spdx") {
    console.error(`${c.red}usage: kit sbom [--format cyclonedx|spdx]${c.reset}`);
    process.exitCode = 1;
    return false;
  }
  const { lockComponents, toCycloneDX, toSpdx } = await import("../sbom.js");
  const { parseLockPkgs } = await import("../supply-chain.js");
  const cwd = process.cwd();
  let lock: Parameters<typeof parseLockPkgs>[0];
  try {
    lock = JSON.parse(readFileSync(resolve(cwd, "package-lock.json"), "utf8"));
  } catch {
    console.error(`${c.red}no package-lock.json found — SBOM needs a committed lockfile${c.reset}`);
    process.exitCode = 1;
    return false;
  }
  const components = lockComponents(parseLockPkgs(lock));
  console.log(
    JSON.stringify(fmt === "spdx" ? toSpdx(components) : toCycloneDX(components), null, 2),
  );
  return true;
}
