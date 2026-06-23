// `kit audit` commands — extracted from cli.ts (split step 4).
import { readSecretAuditEvents, groupBySecret, summarize } from "../audit-secrets.js";
import { readAuditLog } from "../audit.js";
import { printAuditTable } from "../output.js";
import { loadConfig } from "../config.js";
import { resolveConfigPath } from "../cli-shared.js";
import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";

async function cmdAuditSecrets(): Promise<boolean> {
  const args = process.argv.slice(4); // after "audit secrets"
  const sinceIdx = args.indexOf("--since-days");
  const sinceDays = sinceIdx >= 0 && args[sinceIdx + 1] ? parseInt(args[sinceIdx + 1], 10) : 30;
  const keyFilter = flagValue(args, "--key");
  const jsonMode = hasFlag(args, "--json");

  const events = await readSecretAuditEvents(process.cwd(), sinceDays);
  const { reports, unattributed } = groupBySecret(events);
  const filteredReports = keyFilter ? reports.filter((r) => r.key === keyFilter) : reports;
  const summary = summarize(filteredReports, sinceDays);

  if (jsonMode) {
    console.log(JSON.stringify({ summary, reports: filteredReports, unattributed }, null, 2));
    return true;
  }

  console.log(
    `${c.bold}${c.cyan}kit audit secrets${c.reset}  ${c.dim}(last ${sinceDays}d)${c.reset}`,
  );
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);

  if (events.length === 0) {
    console.log(`${c.dim}No secret-related events in audit log (.kit-audit.jsonl).${c.reset}\n`);
    return true;
  }

  console.log(
    `${c.bold}${summary.totalEvents}${c.reset} event(s) across ${c.bold}${summary.keyCount}${c.reset} key(s)`,
  );
  if (summary.topKey) {
    console.log(
      `${c.dim}Most touched: ${c.bold}${summary.topKey.key}${c.reset}${c.dim} (${summary.topKey.count} events)${c.reset}`,
    );
  }
  console.log();

  for (const r of filteredReports.slice(0, 20)) {
    console.log(`${c.bold}${r.key}${c.reset}  ${c.dim}(${r.events.length} events)${c.reset}`);
    for (const e of r.events.slice(-10)) {
      const icon = e.success ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      const ts = e.timestamp.slice(0, 19);
      const agent = e.agent ? `[${e.agent}]` : "";
      const detail = e.detail ? `  ${c.dim}${e.detail}${c.reset}` : "";
      console.log(`  ${icon} ${ts}  ${e.operation}  ${c.dim}${agent}${c.reset}${detail}`);
    }
    if (r.events.length > 10) {
      console.log(`  ${c.dim}… ${r.events.length - 10} earlier events truncated${c.reset}`);
    }
    console.log();
  }

  if (!keyFilter && unattributed.length > 0) {
    console.log(
      `${c.dim}+ ${unattributed.length} event(s) couldn't be tied to a specific key. Use ${c.bold}--json${c.reset}${c.dim} for the full set.${c.reset}\n`,
    );
  }

  return true;
}

export async function cmdAudit(): Promise<boolean> {
  const args = process.argv.slice(3);

  // Sub-sub: kit audit secrets [--since-days N] [--key NAME] [--json]
  if (args[0] === "secrets") {
    return cmdAuditSecrets();
  }

  // Parse --limit N
  let limit = 20;
  const limitIdx = args.indexOf("--limit");
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    const parsed = parseInt(args[limitIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) limit = parsed;
  }

  // Parse --operation <name>
  let operationFilter: string | undefined;
  const opIdx = args.indexOf("--operation");
  if (opIdx !== -1 && args[opIdx + 1]) {
    operationFilter = args[opIdx + 1];
  }

  // Determine log file path (use config if available, else default)
  let logFile = ".kit-audit.jsonl";
  try {
    const config = await loadConfig(resolveConfigPath());
    const govFile = config.governance?.audit?.log_file;
    if (govFile) logFile = govFile;
  } catch {
    // No .kit.toml — use default log file
  }

  let events = await readAuditLog(logFile, limit * 5); // read extra to allow filtering

  if (operationFilter) {
    events = events.filter((e) => e.operation.includes(operationFilter!));
  }

  // Apply limit after filter
  events = events.slice(-limit);

  printAuditTable(events);

  if (events.length > 0) {
    console.log();
    console.log(`${c.dim}Showing ${events.length} entries from ${logFile}${c.reset}`);
  }

  return true;
}
