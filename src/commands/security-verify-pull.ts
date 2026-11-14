import { c } from "../utils/colors.js";
import { hasFlag, flagValue } from "../utils/flags.js";
import { redactSecrets } from "../utils/redactSecrets.js";
import {
  auditPull,
  defaultPullBase,
  reportSeverity,
  type PullAuditReport,
} from "../post-pull-audit.js";
import { pulledAgentFileLines } from "../pull-agent-files.js";

/** An explicit flag without a value stays invalid instead of selecting a default. */
function pullRefValue(args: string[], flag: "--base" | "--head"): string | undefined {
  return flagValue(args, flag) ?? (hasFlag(args, flag) ? "" : undefined);
}

/** The base ref verify-pull audits from, and the header (with the fallback note when there is one). */
async function verifyPullBase(
  args: string[],
  head: string,
): Promise<{ base: string; header: string }> {
  const named = pullRefValue(args, "--base");
  const { base, fallback } =
    named !== undefined ? { base: named, fallback: false } : await defaultPullBase(process.cwd());
  let header = `${c.bold}${c.cyan}kit security verify-pull${c.reset}  ${c.dim}(${redactSecrets(base)} → ${redactSecrets(head)})${c.reset}`;
  if (fallback)
    header += `\n${c.dim}No usable ORIG_HEAD (set by git pull / merge), so only the last commit is audited. Name the pre-pull commit with --base to audit the whole pull.${c.reset}`;
  return { base, header };
}

function printPullScope(report: PullAuditReport): void {
  console.log(
    `${c.dim}Scope: tracked package.json dependency specifications and changed head blobs.${c.reset}`,
  );
  console.log(
    `${c.dim}Not covered: lockfile dependency resolution, package reputation, malware analysis or install enforcement.${c.reset}\n`,
  );
  if (report.coverage.status === "incomplete") {
    console.log(
      `${c.red}✗ Incomplete inspection. Unknown input cannot be treated as clean.${c.reset}`,
    );
    for (const error of report.errors) {
      console.log(
        `  ${c.red}•${c.reset} ${error.code} (${error.operation}, ${error.file ?? error.ref}): ${error.message}`,
      );
    }
    console.log();
  }

  if (report.coverage.fileScope === "unknown") {
    console.log(`${c.dim}File scope is unknown.${c.reset}\n`);
  } else {
    console.log(
      `${c.dim}${report.changedFiles.length} added/modified file(s), ${report.removedFiles.length} removed file(s)${c.reset}\n`,
    );
  }
}

function printPullDependencies(report: PullAuditReport): void {
  if (report.dependencyChanges.length > 0) {
    console.log(
      `${c.yellow}⚠ ${report.dependencyChanges.length} dependency specification change(s):${c.reset}`,
    );
    for (const change of report.dependencyChanges) {
      console.log(
        `  ${c.yellow}•${c.reset} ${change.file} [${change.section}] ${change.name} (${change.kind})`,
      );
      console.log(`    ${change.before ?? "(absent)"} → ${change.after ?? "(absent)"}`);
    }
    console.log(
      `${c.dim}  Review each added or changed source/version before installing.${c.reset}`,
    );
    console.log();
  }
}

function printPullGitignoreRemovals(report: PullAuditReport): void {
  if (report.gitignoreRemovals.length > 0) {
    const sensitive = report.gitignoreRemovals.some((removal) => removal.sensitive);
    const severityIcon = sensitive ? `${c.red}✗` : `${c.yellow}⚠`;
    console.log(
      `${severityIcon}${c.reset} ${report.gitignoreRemovals.length} .gitignore entry/-ies removed:`,
    );
    for (const removal of report.gitignoreRemovals) {
      const hot = removal.sensitive;
      const tag = hot ? `${c.red}[sensitive]${c.reset}` : `${c.dim}[low]${c.reset}`;
      console.log(`  ${hot ? c.red : c.yellow}•${c.reset} ${removal.entry}  ${tag}`);
    }
    console.log();
  }
}

function printPullPlaintextHits(report: PullAuditReport): void {
  if (report.plaintextHits.length > 0) {
    const total = report.plaintextHits.reduce((sum, h) => sum + h.findings.length, 0);
    console.log(
      `${c.red}✗ ${total} plaintext secret(s) introduced in ${report.plaintextHits.length} file(s):${c.reset}`,
    );
    for (const hit of report.plaintextHits.slice(0, 20)) {
      const labels = hit.findings.map((f) => `${f.label}:${f.preview}`).join(", ");
      console.log(`  ${c.red}•${c.reset} ${hit.file}  ${c.dim}${labels}${c.reset}`);
    }
    if (report.plaintextHits.length > 20) {
      console.log(`  ${c.dim}… ${report.plaintextHits.length - 20} more${c.reset}`);
    }
    console.log();
  }
}

function printPullPolicyChanges(report: PullAuditReport): void {
  if (report.allowlistChanged || report.policyChanged || report.kitTomlChanged) {
    console.log(`${c.yellow}⚠ Security-policy files modified:${c.reset}`);
    if (report.allowlistChanged) console.log(`  ${c.yellow}•${c.reset} .kit-allowlist.json`);
    if (report.policyChanged) console.log(`  ${c.yellow}•${c.reset} .kit-policy.json`);
    if (report.kitTomlChanged) console.log(`  ${c.yellow}•${c.reset} .kit.toml`);
    console.log(
      `${c.dim}  → run ${c.bold}kit security policy check${c.reset}${c.dim} to verify the new state.${c.reset}\n`,
    );
  }
}

export async function cmdSecurityVerifyPull(): Promise<boolean> {
  // kit security verify-pull [--base <ref>] [--head <ref>] [--json]
  const args = process.argv.slice(4);
  const head = pullRefValue(args, "--head") ?? "HEAD";
  const jsonMode = hasFlag(args, "--json");
  const { base, header } = await verifyPullBase(args, head);

  const report = await auditPull(process.cwd(), base, head);
  const severity = reportSeverity(report);

  if (jsonMode) {
    console.log(JSON.stringify({ severity, ...report }, null, 2));
    return severity !== "fail";
  }

  console.log(header);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}\n`);
  printPullScope(report);
  printPullDependencies(report);

  printPullGitignoreRemovals(report);

  printPullPlaintextHits(report);

  printPullPolicyChanges(report);

  for (const line of pulledAgentFileLines(report.agentFiles, c)) console.log(line);

  if (severity === "ok") {
    console.log(`${c.green}✓ No findings within the reported inspection scope.${c.reset}\n`);
    return true;
  }
  if (severity === "warn") {
    console.log(
      `${c.yellow}⚠ Pull contains items for review. Address them before install/deploy.${c.reset}\n`,
    );
    return true;
  }
  console.log(
    `${c.red}✗ Pull inspection failed or found security regressions. Review before continuing.${c.reset}\n`,
  );
  return false;
}
