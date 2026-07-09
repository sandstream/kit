// `kit sbom` command — extracted from cli.ts (incremental split).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { flagValue, hasFlag } from "../utils/flags.js";
import type { Component } from "../sbom.js";

export async function cmdSbom(): Promise<boolean> {
  const fmt = (flagValue(process.argv, "--format") ?? "cyclonedx").toLowerCase();
  if (fmt !== "cyclonedx" && fmt !== "spdx") {
    console.error(`${c.red}usage: kit sbom [--format cyclonedx|spdx] [--agent]${c.reset}`);
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
  const components: Component[] = lockComponents(parseLockPkgs(lock));

  // --agent (G5): also inventory the agent toolchain — skills, MCP servers, plugins —
  // which no lockfile lists. Opt-in so the default BOM is unchanged. Discovery is
  // shared with `kit insight` (agent-sbom.discoverAgentToolchain) so both see the
  // same loaded set.
  if (hasFlag(process.argv, "--agent")) {
    const { agentToolchainComponents, discoverAgentToolchain } = await import("../agent-sbom.js");
    components.push(...agentToolchainComponents(discoverAgentToolchain(cwd)));
  }

  console.log(
    JSON.stringify(fmt === "spdx" ? toSpdx(components) : toCycloneDX(components), null, 2),
  );
  return true;
}
