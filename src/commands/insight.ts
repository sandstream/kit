/**
 * `kit insight` — Pillar 4's deterministic lifecycle-insight surface. First
 * subcommand: `unused` — which loaded MCP servers / skills were never actually
 * called, correlating the loaded toolchain (agent-sbom) against recorded usage
 * (the memory index's tool_uses table: MCP tools by `mcp__<server>__<tool>`,
 * skills by the `Skill` tool's `{skill}` input). Zero-LLM, pure counting.
 *
 * Honesty (no false green): reports SUGGESTIONS, never auto-removes; and with no
 * indexed usage it SKIPS ("can't judge") rather than declaring everything unused.
 */
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { discoverAgentToolchain } from "../agent-sbom.js";
import { scanToolUsage, scanSkillUsage, hasIndexedToolUsage } from "../insight/usage-scan.js";
import { computeUnused } from "../insight/unused.js";

async function insightUnused(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const cwd = process.cwd();
  const loaded = discoverAgentToolchain(cwd);

  const { openMemoryDb } = await import("../memory/db.js");
  const db = openMemoryDb();
  try {
    const indexed = hasIndexedToolUsage(db);
    if (!indexed) {
      if (jsonMode) {
        console.log(JSON.stringify({ skipped: true, reason: "no indexed tool usage" }, null, 2));
        return true;
      }
      console.log(`${c.bold}kit insight${c.reset} — loaded-but-unused`);
      console.log(
        `  ${c.yellow}!${c.reset} ${c.dim}no indexed tool usage — can't judge (run your agent, then ${c.reset}${c.bold}kit memory index${c.reset}${c.dim}). Skipped.${c.reset}`,
      );
      return true;
    }

    const usage = scanToolUsage(db);
    const skillUsage = scanSkillUsage(db);
    const report = computeUnused(loaded, usage, skillUsage);

    if (jsonMode) {
      console.log(JSON.stringify({ skipped: false, ...report }, null, 2));
      return true;
    }

    const total = usage.reduce((n, e) => n + e.count, 0);
    console.log(
      `${c.bold}kit insight${c.reset} — loaded-but-unused  ${c.dim}(${total} tool call(s) indexed)${c.reset}`,
    );

    const mcp = report.findings.filter((f) => f.kind === "mcp-server");
    const skills = report.findings.filter((f) => f.kind === "skill");

    if (mcp.length > 0) {
      console.log(`  ${c.bold}mcp servers${c.reset}`);
      for (const f of mcp) {
        const mark = f.verdict === "used" ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
        const tag =
          f.verdict === "used" ? `${c.green}used${c.reset}   ` : `${c.yellow}UNUSED${c.reset} `;
        const note = f.verdict === "unused" ? `  ${c.dim}declared, never called${c.reset}` : "";
        console.log(`    ${mark} ${tag} ${f.name}  ${c.dim}${f.refs} ref(s)${c.reset}${note}`);
      }
    }
    if (skills.length > 0) {
      console.log(`  ${c.bold}skills${c.reset}`);
      for (const f of skills) {
        const mark = f.verdict === "used" ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
        const tag =
          f.verdict === "used" ? `${c.green}used${c.reset}   ` : `${c.yellow}UNUSED${c.reset} `;
        const note = f.verdict === "unused" ? `  ${c.dim}loaded, never invoked${c.reset}` : "";
        console.log(
          `    ${mark} ${tag} ${f.name}  ${c.dim}${f.refs} invocation(s)${c.reset}${note}`,
        );
      }
    }
    if (loaded.skills.length === 0 && loaded.mcpServers.length === 0) {
      console.log(
        `  ${c.dim}no agent toolchain detected (.claude/skills, .mcp.json, …) — nothing to correlate.${c.reset}`,
      );
    }

    if (report.pruneCandidates.length > 0) {
      console.log(
        `  ${c.dim}→ prune candidates: ${c.reset}${report.pruneCandidates.join(", ")}  ${c.dim}(kit removes nothing automatically)${c.reset}`,
      );
    }
    return true;
  } finally {
    db.close();
  }
}

export async function cmdInsight(): Promise<boolean> {
  const sub = process.argv[3] ?? "unused";
  if (sub === "unused") return await insightUnused();
  console.error(`${c.red}usage: kit insight <unused> [--json]${c.reset}`);
  return false;
}
