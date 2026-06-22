import type { ToolStatus } from "./check-tools.js";
import type { ServiceStatus } from "./check-services.js";
import type { SecretStatus } from "./check-secrets.js";
import type { SkillCheckResult } from "./check-skills.js";
import type { SecurityCheckResult } from "./check-security.js";
import type { LockCheckResult } from "./check-lock.js";
import { safeStatusLine } from "./utils/redactSecrets.js";

// ANSI color codes
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const CHECK = `${c.green}✓${c.reset}`;
const CROSS = `${c.red}✗${c.reset}`;
const WARN = `${c.yellow}!${c.reset}`;

function pad(s: string, len: number): string {
  // Strip ANSI for length calculation
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
  return s + " ".repeat(Math.max(0, len - stripped.length));
}

function header(title: string): void {
  console.log();
  console.log(`${c.bold}${c.cyan}${title}${c.reset}`);
  console.log(`${c.dim}${"─".repeat(50)}${c.reset}`);
}

/** Section header for a group of live steps (e.g. "Checks"). */
export function stepHeader(title: string): void {
  header(title);
}

/** Human-readable duration: sub-second in ms, otherwise one-decimal seconds. */
export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Run a labeled async step with live terminal feedback + timing.
 *
 * On a TTY: prints a "running" line, then rewrites it in place to ✓/✗ with the
 * elapsed time. On a pipe/CI (non-TTY): prints a start line and a separate end
 * line (no cursor rewrite, so logs stay readable). Returns the fn's result; on
 * throw, marks the step ✗ and re-throws so callers keep their control flow.
 *
 * Shares its visual language (▶ / ✓ / ✗ + step duration) with the shell
 * pre-commit hook generated in hooks.ts.
 */
export async function runStep<T>(
  label: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const start = Date.now();
  const tty = process.stdout.isTTY === true;

  if (tty) {
    process.stdout.write(`  ${c.cyan}▶${c.reset} ${label}${c.dim}…${c.reset}`);
  } else {
    console.log(`  ${c.cyan}▶${c.reset} ${label}`);
  }

  try {
    const result = await fn();
    const dur = `${c.dim}${fmtDuration(Date.now() - start)}${c.reset}`;
    if (tty) {
      process.stdout.write(`\r\x1b[K  ${CHECK} ${label}  ${dur}\n`);
    } else {
      console.log(`  ${CHECK} ${label}  ${dur}`);
    }
    return result;
  } catch (err) {
    const dur = `${c.dim}${fmtDuration(Date.now() - start)}${c.reset}`;
    if (tty) {
      process.stdout.write(`\r\x1b[K  ${CROSS} ${label}  ${dur}\n`);
    } else {
      console.log(`  ${CROSS} ${label}  ${dur}`);
    }
    throw err;
  }
}

export function printToolsTable(tools: ToolStatus[]): void {
  if (tools.length === 0) return;

  header("Tools");

  const nameWidth = Math.max(12, ...tools.map((t) => t.name.length)) + 2;

  for (const tool of tools) {
    const icon = tool.ok ? CHECK : CROSS;
    const name = pad(tool.name, nameWidth);
    const version = tool.installed
      ? `${c.dim}${tool.installed}${c.reset}`
      : `${c.red}not installed${c.reset}`;
    const required = `${c.gray}(need ${tool.required})${c.reset}`;
    console.log(`  ${icon} ${name} ${version}  ${required}`);
  }
}

export function printServicesTable(services: ServiceStatus[]): void {
  if (services.length === 0) return;

  header("Services");

  const nameWidth = Math.max(12, ...services.map((s) => s.name.length)) + 2;

  for (const svc of services) {
    const icon = svc.authenticated ? CHECK : CROSS;
    const name = pad(svc.name, nameWidth);
    const status = svc.authenticated
      ? `${c.green}authenticated${c.reset}`
      : `${c.red}not authenticated${c.reset}`;
    const detail = svc.output ? `  ${c.gray}${safeStatusLine(svc.output, 60)}${c.reset}` : "";
    console.log(`  ${icon} ${name} ${status}${detail}`);
  }
}

export function printSecretsTable(
  templateExists: boolean | null,
  secrets: SecretStatus[],
): void {
  if (secrets.length === 0 && templateExists === null) return;

  header("Secrets");

  if (templateExists !== null) {
    const icon = templateExists ? CHECK : CROSS;
    const status = templateExists
      ? `${c.green}found${c.reset}`
      : `${c.red}missing${c.reset}`;
    console.log(`  ${icon} ${pad("template", 14)} ${status}`);
  }

  // When every 1Password-backed secret fails with the same auth error,
  // collapse them into one banner line instead of spamming N identical rows.
  const opSecrets = secrets.filter((s) => s.source === "1password");
  const opUnauth = opSecrets.filter((s) =>
    s.detail.startsWith("1Password not authenticated"),
  );
  const aggregate1pUnauth =
    opSecrets.length > 0 && opUnauth.length === opSecrets.length;

  if (aggregate1pUnauth) {
    console.log(
      `  ${CROSS} ${c.red}1Password not authenticated${c.reset} ${c.gray}(${opUnauth.length} secret(s) blocked)${c.reset}`,
    );
    console.log(`    ${c.yellow}→ run 'op signin' to authenticate${c.reset}`);
  }

  const renderable = aggregate1pUnauth
    ? secrets.filter((s) => s.source !== "1password")
    : secrets;

  if (renderable.length === 0) return;

  const nameWidth = Math.max(14, ...renderable.map((s) => s.name.length)) + 2;

  for (const secret of renderable) {
    const icon = secret.available ? CHECK : CROSS;
    const name = pad(secret.name, nameWidth);
    const source = `${c.gray}[${secret.source}]${c.reset}`;
    const detail = secret.available
      ? `${c.green}available${c.reset}`
      : `${c.red}${secret.detail}${c.reset}`;
    console.log(`  ${icon} ${name} ${source} ${detail}`);
  }
}

export function printSkillsTable(skills: SkillCheckResult[]): void {
  if (skills.length === 0) return;

  header("Skills");

  const nameWidth = Math.max(12, ...skills.map((s) => s.name.length)) + 2;

  for (const skill of skills) {
    const icon = skill.installed ? CHECK : skill.required ? CROSS : WARN;
    const name = pad(skill.name, nameWidth);
    const tag = skill.required
      ? `${c.gray}[required]${c.reset}`
      : `${c.gray}[optional]${c.reset}`;
    const status = skill.installed
      ? `${c.green}installed${c.reset}`
      : skill.required
        ? `${c.red}missing${c.reset}`
        : `${c.yellow}not installed${c.reset}`;
     const version = `${c.dim}${skill.versionSpec}${c.reset}`;
     console.log(`  ${icon} ${name} ${tag} ${status}  ${version}`);
   }
 }

 export function printSecurityTable(results: SecurityCheckResult[]): void {
  if (results.length === 0) return;

  header("Security");

  // Group by category
  const byCategory: Record<string, SecurityCheckResult[]> = {};
  for (const result of results) {
    if (!byCategory[result.category]) {
      byCategory[result.category] = [];
    }
    byCategory[result.category].push(result);
  }

  const categories = ["dependency", "exposure", "supply-chain", "secrets"] as const;
  
  for (const category of categories) {
    const items = byCategory[category];
    if (!items || items.length === 0) continue;

    const nameWidth = Math.max(20, ...items.map((r) => r.name.length)) + 2;

    for (const result of items) {
      const icon =
        result.status === "pass"
          ? CHECK
          : result.status === "fail"
            ? CROSS
            : result.status === "warn"
              ? WARN
              : `${c.dim}−${c.reset}`;

      const name = pad(result.name, nameWidth);
      
      const statusColor =
        result.status === "pass"
          ? c.green
          : result.status === "fail"
            ? c.red
            : result.status === "warn"
              ? c.yellow
              : c.dim;

      const detail = `${c.gray}${result.detail}${c.reset}`;
      
      const severity = result.severity
        ? `${c.dim}[${result.severity}]${c.reset}`
        : "";

      const ruleTag = result.rule ? ` ${c.dim}[${result.rule.id}]${c.reset}` : "";

      console.log(`  ${icon} ${name} ${statusColor}${result.status}${c.reset}  ${detail} ${severity}${ruleTag}`);
      
      // Show affected files if available (limit to first 5)
      if (result.files && result.files.length > 0) {
        const filesToShow = result.files.slice(0, 5);
        for (const file of filesToShow) {
          console.log(`    ${c.dim}• ${file}${c.reset}`);
        }
        if (result.files.length > 5) {
          console.log(`    ${c.dim}... and ${result.files.length - 5} more file(s)${c.reset}`);
        }
      }
      
      // Show suggestion/remediation if available
      if (result.suggestion) {
        console.log(`    ${c.yellow}${result.suggestion}${c.reset}`);
      }
    }
  }
}

export function printLockTable(results: LockCheckResult[]): void {
  if (results.length === 0) return;

  header("Lock Files");

  for (const result of results) {
    const icon = result.inSync ? CHECK : result.exists ? WARN : CROSS;
    const name = result.category === "skills-lock" ? "skills-lock.json" : "cli-lock.json";
    const status = result.inSync
      ? `${c.green}in sync${c.reset}`
      : result.exists
        ? `${c.yellow}out of sync${c.reset}`
        : `${c.red}missing${c.reset}`;
    const detail = `${c.gray}${result.detail}${c.reset}`;
    console.log(`  ${icon} ${pad(name, 20)} ${status}  ${detail}`);
    
    if (result.missing.length > 0 && result.missing.length <= 5) {
      const missingList = result.missing.join(", ");
      console.log(`    ${c.dim}Missing: ${missingList}${c.reset}`);
    }
  }
}

export function printAuditTable(events: import("./audit.js").AuditEvent[]): void {
  if (events.length === 0) {
    console.log(`${c.dim}No audit log entries found.${c.reset}`);
    return;
  }

  header("Audit Log");

  const opWidth = Math.max(14, ...events.map((e) => e.operation.length)) + 2;
  const envWidth = Math.max(6, ...events.map((e) => e.environment.length)) + 2;
  const actorWidth = Math.max(8, ...events.map((e) => (e.agent_name ?? e.agent_id ?? "unknown").length)) + 2;

  for (const event of events) {
    const icon = event.success ? CHECK : CROSS;
    const ts = new Date(event.timestamp).toLocaleString();
    const op = pad(event.operation, opWidth);
    const env = pad(`[${event.environment}]`, envWidth + 2);
    const actor = pad(event.agent_name ?? event.agent_id ?? "unknown", actorWidth);
    const duration = event.duration_ms != null ? `${c.dim}${event.duration_ms}ms${c.reset}` : "";

    console.log(`  ${icon} ${c.dim}${ts}${c.reset}  ${op}  ${c.gray}${env}${c.reset}  ${actor}  ${duration}`);

    if (event.error) {
      console.log(`    ${c.red}Error: ${event.error}${c.reset}`);
    }
  }
}

export function printSummary(
  tools: ToolStatus[],
  services: ServiceStatus[],
  secrets: SecretStatus[],
  security?: SecurityCheckResult[],
): void {
  console.log();

  const toolsOk = tools.filter((t) => t.ok).length;
  const servicesOk = services.filter((s) => s.authenticated).length;
  const secretsOk = secrets.filter((s) => s.available).length;
  const securityOk = security
    ? security.filter((s) => s.status === "pass" || s.status === "skip").length
    : 0;

  const total = tools.length + services.length + secrets.length + (security?.length || 0);
  const ok = toolsOk + servicesOk + secretsOk + securityOk;
  const allGood = ok === total;

  if (allGood) {
    console.log(`${c.bold}${c.green}All ${total} checks passed ✓${c.reset}`);
  } else {
    console.log(
      `${c.bold}${ok}/${total} checks passed${c.reset}` +
        `  ${c.red}(${total - ok} issues)${c.reset}`,
    );
    console.log();
    console.log(`${c.dim}Run ${c.reset}${c.bold}kit install${c.reset}${c.dim} to fix tools, ${c.reset}${c.bold}kit login${c.reset}${c.dim} to fix auth${c.reset}`);
  }

  console.log();
}
