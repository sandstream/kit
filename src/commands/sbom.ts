// `kit sbom` command — extracted from cli.ts (incremental split).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { flagValue, hasFlag } from "../utils/flags.js";
import type { Component } from "../sbom.js";
import type { AgentComponentInput } from "../agent-sbom.js";

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
  // which no lockfile lists. Opt-in so the default BOM is unchanged.
  if (hasFlag(process.argv, "--agent")) {
    const { agentToolchainComponents, mcpServersFromConfig } = await import("../agent-sbom.js");
    components.push(...agentToolchainComponents(discoverAgentToolchain(cwd, mcpServersFromConfig)));
  }

  console.log(
    JSON.stringify(fmt === "spdx" ? toSpdx(components) : toCycloneDX(components), null, 2),
  );
  return true;
}

/** Best-effort, defensive discovery of agent-toolchain pieces under `cwd`. */
function discoverAgentToolchain(
  cwd: string,
  mcpServersFromConfig: (json: unknown) => AgentComponentInput[],
): { skills: AgentComponentInput[]; mcpServers: AgentComponentInput[] } {
  const skills: AgentComponentInput[] = [];
  // Skills: each subdir of .claude/skills holding a SKILL.md is one skill.
  const skillsDir = resolve(cwd, ".claude/skills");
  try {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(resolve(skillsDir, entry.name, "SKILL.md"))) {
        skills.push({ name: entry.name, source: `.claude/skills/${entry.name}` });
      }
    }
  } catch {
    /* no skills dir — fine */
  }

  // MCP servers: union across the common config locations (reuses agent-sbom's parser).
  const mcpServers: AgentComponentInput[] = [];
  const seen = new Set<string>();
  for (const rel of [".mcp.json", ".claude.json", ".cursor/mcp.json", ".vscode/mcp.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(cwd, rel), "utf8"));
      for (const s of mcpServersFromConfig(parsed)) {
        if (!seen.has(s.name)) {
          seen.add(s.name);
          mcpServers.push(s);
        }
      }
    } catch {
      /* missing/malformed config — skip */
    }
  }
  return { skills, mcpServers };
}
