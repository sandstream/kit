// `kit upstream check` command: what changed upstream for the services this project uses.
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import type { UpstreamReport, UpstreamRow } from "../upstream-report.js";

function mark(verdict: UpstreamRow["verdict"]): string {
  switch (verdict) {
    case "current":
      return `${c.green}✓${c.reset}`;
    case "unknown":
    case "skipped":
      return `${c.dim}?${c.reset}`;
    case "upgrade available":
      return `${c.yellow}!${c.reset}`;
    default:
      return `${c.red}✗${c.reset}`;
  }
}

function describeRow(row: UpstreamRow): string[] {
  const name = row.package ?? row.label;
  const where = row.manifest && row.manifest !== "package.json" ? ` (${row.manifest})` : "";
  const versions =
    row.installed || row.latest
      ? `${row.installed ?? "?"} -> ${row.latest ?? "?"}${row.bump !== "unknown" && row.bump !== "none" ? ` (${row.bump})` : ""}`
      : "";
  const lines = [
    `  ${mark(row.verdict)} ${c.bold}${name}${c.reset}${where}  ${versions}  ${c.dim}${row.verdict}${c.reset}`,
  ];
  for (const hit of row.notes) lines.push(`      ${c.dim}${hit.tag}: ${hit.line}${c.reset}`);
  if (row.notes.length > 0) {
    lines.push(
      `      ${c.dim}(keyword match on release notes, not proof that code must change)${c.reset}`,
    );
  }
  if (!row.notesAvailable && row.verdict !== "current" && row.verdict !== "skipped") {
    lines.push(`      ${c.dim}no GitHub release notes could be read for this service${c.reset}`);
  }
  if (row.detail) lines.push(`      ${c.dim}${row.detail}${c.reset}`);
  return lines;
}

function renderText(report: UpstreamReport): void {
  console.log(
    `${c.bold}kit upstream${c.reset}  ${c.dim}latest versions and release notes of the services in use${c.reset}`,
  );
  if (report.status === "skipped") {
    console.log(
      `  skipped (${report.reason ?? "no network"}): no version was looked up, nothing is reported as current`,
    );
  }
  if (report.rows.length === 0)
    console.log("  no cataloged service found in .kit.toml or any package.json");
  for (const row of report.rows) for (const line of describeRow(row)) console.log(line);
  for (const s of report.skippedInputs) {
    console.log(`  ${c.yellow}!${c.reset} could not read ${s.path}: ${s.reason}`);
  }
}

export async function cmdUpstream(): Promise<boolean> {
  const args = process.argv.slice(3).filter((a) => !a.startsWith("--"));
  if (args.length > 1 || (args.length === 1 && args[0] !== "check")) {
    console.error(`${c.red}usage: kit upstream [check] [--json] [--enforce]${c.reset}`);
    return false;
  }
  const { buildUpstreamReport, enforceFails } = await import("../upstream-report.js");
  let report: UpstreamReport;
  try {
    report = await buildUpstreamReport(process.cwd());
  } catch (err) {
    console.error(
      `${c.red}kit upstream: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    return false;
  }
  const failed = hasFlag(process.argv, "--enforce") && enforceFails(report);
  if (hasFlag(process.argv, "--json"))
    console.log(JSON.stringify({ ok: !failed, ...report }, null, 2));
  else renderText(report);
  return !failed;
}
