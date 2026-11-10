/**
 * Compare loaded components with references in retained indexed messages.
 * Missing MCP references support a removal suggestion only when native capture is complete for those messages.
 * Missing explicit Skill references remain unknown because files can be read without a Skill call.
 * Unindexed history and uncaptured subagents remain outside this evidence.
 */
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { discoverAgentToolchain } from "../agent-sbom.js";
import {
  scanToolUsage,
  scanSkillUsage,
  scanToolCapture,
  type ToolCaptureCoverage,
  type ToolUsageEntry,
} from "../insight/usage-scan.js";
import { computeUnused, type UnusedFinding, type UnusedReport } from "../insight/unused.js";

function readUsageSnapshot(db: DatabaseSync | undefined) {
  // Use one read snapshot for both references and the capture that qualifies their absence.
  db?.exec("BEGIN");
  const usage = db ? scanToolUsage(db) : [];
  const skillUsage = db ? scanSkillUsage(db) : undefined;
  const capture = db
    ? scanToolCapture(db)
    : {
        complete: false,
        observedMessages: 0,
        incompleteMessages: 0,
        orphanToolCalls: 0,
      };
  db?.exec("COMMIT");
  return { usage, skillUsage, capture };
}

function printFindingGroup(title: string, findings: UnusedFinding[], referenceLabel: string): void {
  if (findings.length === 0) return;
  console.log(`  ${c.bold}${title}${c.reset}`);
  for (const f of findings) {
    const mark = f.verdict === "used" ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
    const tag =
      f.verdict === "used"
        ? `${c.green}used${c.reset}   `
        : f.verdict === "unused"
          ? `${c.yellow}UNUSED${c.reset} `
          : `${c.dim}unknown${c.reset}`;
    const note =
      f.verdict === "unused"
        ? `  ${c.dim}no recorded reference within covered history${c.reset}`
        : "";
    console.log(
      `    ${mark} ${tag} ${f.name}  ${c.dim}${f.refs} ${referenceLabel}${c.reset}${note}`,
    );
  }
}

function printUnusedReport(
  report: UnusedReport,
  usage: ToolUsageEntry[],
  capture: ToolCaptureCoverage,
): void {
  const total = usage.reduce((n, e) => n + e.count, 0);
  console.log(
    `${c.bold}kit insight${c.reset}: tool usage  ${c.dim}(${total} tool call(s) indexed)${c.reset}`,
  );
  console.log(
    capture.complete
      ? `  Tool capture: complete for ${capture.observedMessages} indexed message(s).`
      : `  Tool capture: incomplete (${capture.incompleteMessages}/${capture.observedMessages} message(s) incomplete; ${capture.orphanToolCalls} orphan call(s)). Missing references are unknown.`,
  );
  console.log(
    "  Scope: retained indexed messages. Unindexed history and uncaptured subagents remain unknown.",
  );
  console.log("  Skill coverage: explicit references only. Missing skill references are unknown.");

  printFindingGroup(
    "mcp servers",
    report.findings.filter((f) => f.kind === "mcp-server"),
    "ref(s)",
  );
  printFindingGroup(
    "skills",
    report.findings.filter((f) => f.kind === "skill"),
    "explicit ref(s)",
  );
  if (report.loaded.skills === 0 && report.loaded.mcpServers === 0) {
    console.log(
      `  ${c.dim}No agent toolchain detected (.claude/skills, .mcp.json). Nothing to correlate.${c.reset}`,
    );
  }
  if (report.pruneCandidates.length > 0) {
    console.log(
      `  ${c.dim}→ prune candidates: ${c.reset}${report.pruneCandidates.join(", ")}  ${c.dim}(kit removes nothing automatically)${c.reset}`,
    );
  }
}

async function insightUnused(): Promise<boolean> {
  const jsonMode = hasFlag(process.argv, "--json");
  const cwd = process.cwd();
  const loaded = discoverAgentToolchain(cwd);

  const { openMemoryDbReadOnly, getMemoryDbPath } = await import("../memory/db.js");
  const db = statSync(getMemoryDbPath(), { throwIfNoEntry: false })
    ? openMemoryDbReadOnly()
    : undefined;
  try {
    const { usage, skillUsage, capture } = readUsageSnapshot(db);
    const report = computeUnused(loaded, usage, skillUsage, capture);
    const skipped = usage.length === 0 && !capture.complete;

    if (jsonMode) {
      console.log(
        JSON.stringify(
          { skipped, ...(skipped ? { reason: "no indexed tool usage" } : {}), ...report, capture },
          null,
          2,
        ),
      );
    } else {
      printUnusedReport(report, usage, capture);
    }
    return true;
  } finally {
    db?.close();
  }
}

export async function cmdInsight(): Promise<boolean> {
  const sub = process.argv[3] ?? "unused";
  if (sub === "unused") return await insightUnused();
  console.error(`${c.red}usage: kit insight <unused> [--json]${c.reset}`);
  return false;
}
