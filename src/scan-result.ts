import { ingestStrict, type IngestOutcome } from "./adapters/ingest.js";
import type { SecurityCheckResult } from "./check-security.js";
import { abortedRun } from "./scan-abort.js";
import { exitGateFinding, socketPolicyVerdict } from "./scan-exit-gate.js";
import type { ScannerDef, ScannerRun } from "./scanners.js";
import { redactSecrets } from "./utils/redactSecrets.js";

export type ScannerProcess = {
  ok: boolean;
  stdout: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  timedOut?: boolean;
  noNumericExitStatus?: true;
};

type SettledScan = { run: ScannerRun; findings?: SecurityCheckResult[] };

const MAX_REASON = 160;
const FAILURE_LINE = new RegExp(
  "error|fatal|fail|cannot|unable|denied|not found|no package|invalid",
  "i",
);
const ANSI_SEQUENCE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");

/** Drop control characters except the newline, so a scanner cannot steer the terminal. */
function withoutControls(text: string): string {
  let out = "";
  for (const ch of text.replace(ANSI_SEQUENCE, "")) {
    const code = ch.charCodeAt(0);
    if (code === 10 || (code > 31 && code !== 127)) out += ch;
  }
  return out;
}

/**
 * One safe line from scanner stderr. Progress lines come first and the cause comes later, so the
 * line that names a failure wins, else the last line. Control characters are removed, credentials
 * redacted, and the length capped.
 */
function scannerReason(stderr: string | undefined): string | undefined {
  const lines = redactSecrets(withoutControls(stderr ?? ""))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const line = lines.find((l) => FAILURE_LINE.test(l)) ?? lines[lines.length - 1];
  return line ? line.slice(0, MAX_REASON) : undefined;
}

function processProblem(
  scanner: ScannerDef,
  process: ScannerProcess,
  findings: SecurityCheckResult[] = [],
): ScannerRun | undefined {
  const stopped = abortedRun(scanner, process);
  if (stopped) return { ...stopped, findings: findings.length, reportGap: "partial" };
  if (
    !process.noNumericExitStatus &&
    (process.ok || (findings.length > 0 && isFindingExit(scanner, process)))
  )
    return undefined;
  return {
    id: scanner.id,
    status: "error",
    findings: findings.length,
    ...(findings.length > 0 ? { reportGap: "partial" as const } : {}),
    reason: scannerReason(process.stderr) ?? processFailureReason(process),
  };
}

function isFindingExit(scanner: ScannerDef, process: ScannerProcess): boolean {
  return (
    !process.noNumericExitStatus &&
    scanner.findingsExit !== undefined &&
    process.exitCode === scanner.findingsExit
  );
}

function processFailureReason(process: ScannerProcess): string {
  if (process.noNumericExitStatus || process.exitCode === undefined)
    return "scanner stopped without returning an exit code";
  return `scanner failed with exit code ${process.exitCode}`;
}

function settleExitGate(scanner: ScannerDef, process: ScannerProcess): SettledScan {
  const healthy = socketPolicyVerdict(process.stdout);
  const stopped = abortedRun(scanner, process);
  const complete = !stopped && !process.noNumericExitStatus;
  if (complete && process.ok && healthy === true)
    return { run: { id: scanner.id, status: "ran", findings: 0 } };
  const finding = !process.ok || healthy === false ? exitGateFinding(scanner, process) : undefined;
  const findings = finding ? [finding] : [];
  if (complete && socketReportedPolicyFailure(process, healthy)) {
    return { run: { id: scanner.id, status: "ran", findings: 1 }, findings };
  }
  const reason = finding?.detail ?? "scanner did not return a valid Socket policy verdict";
  const reportGap = socketReportGap(process.stdout, healthy, Boolean(stopped));
  return {
    run: {
      ...(stopped ?? { id: scanner.id, status: "error" }),
      findings: findings.length,
      reason: stopped?.reason ?? reason,
      reportGap,
    },
    findings,
  };
}

function socketReportedPolicyFailure(
  process: ScannerProcess,
  healthy: boolean | undefined,
): boolean {
  return !process.ok && process.exitCode === 1 && healthy === false;
}

function socketReportGap(
  stdout: string,
  healthy: boolean | undefined,
  stopped: boolean,
): "partial" | "malformed" | "missing" {
  if (stopped || healthy !== undefined) return "partial";
  return stdout.trim() ? "malformed" : "missing";
}

/** Keep validated findings even when the delegate or its report has incomplete coverage. */
export function settleScanner(scanner: ScannerDef, process: ScannerProcess): SettledScan {
  if (scanner.exitGate) return settleExitGate(scanner, process);
  const outcome = ingestStrict(scanner.format, process.stdout);
  const findings = outcome.ok ? outcome.findings : [];
  const problems = processProblem(scanner, process, findings);
  if (problems && (process.timedOut || process.truncated || process.noNumericExitStatus))
    return { run: problems, findings };

  if (
    !process.stdout.trim() &&
    scanner.noTargetExit !== undefined &&
    process.exitCode === scanner.noTargetExit
  ) {
    return {
      run: {
        id: scanner.id,
        status: "not-applicable",
        findings: 0,
        noTarget: true,
        reason: scannerReason(process.stderr),
      },
    };
  }
  return settleReport(scanner.id, outcome, problems);
}

function settleReport(
  scannerId: string,
  outcome: IngestOutcome,
  problems: ScannerRun | undefined,
): SettledScan {
  if (!outcome.ok) {
    const status = outcome.reportGap === "partial" ? "partial" : "error";
    const reason = outcome.reportGap === "missing" && problems ? problems.reason : outcome.reason;
    return { run: { id: scannerId, status, findings: 0, reportGap: outcome.reportGap, reason } };
  }
  const findings = outcome.findings;
  if (problems) return { run: problems, findings };
  const run: ScannerRun = { id: scannerId, status: "ran", findings: findings.length };
  if (outcome.coverage === "partial") {
    run.status = "partial";
    run.reportGap = outcome.reportGap ?? "partial";
    run.reason = outcome.notes?.join(" ");
  }
  return { run, findings };
}
