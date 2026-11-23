import { ingestStrict, type IngestGap, type IngestOutcome } from "./adapters/ingest.js";
import type { SecurityCheckResult } from "./check-security.js";
import { abortedRun } from "./scan-abort.js";
import { exitGateFinding, readSocketPolicy } from "./scan-exit-gate.js";
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
  evidence?: ScannerEvidence;
};

export type InventoryFinding = { name: string; version: string };

export type ScannerEvidence =
  | {
      status: "complete";
      packageCount?: number;
      checkCount?: number;
      fileCount?: number;
      targetFiles?: string[];
      requiredFindings?: InventoryFinding[];
    }
  | { status: "not-applicable"; reason: string }
  | { status: "partial"; reportGap: IngestGap; reason: string };

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
  const { verdict, reportedViolation, reportGap } = readSocketPolicy(process.stdout);
  const stopped = abortedRun(scanner, process);
  const finding =
    !process.ok || reportedViolation
      ? exitGateFinding(scanner, process, reportedViolation)
      : undefined;
  const findings = finding ? [finding] : [];
  if (!stopped && socketVerdictMatchesExit(process, verdict)) {
    return {
      run: {
        id: scanner.id,
        status: "partial",
        findings: findings.length,
        reportGap: "partial",
        reason: "Socket CI did not provide policy coverage evidence for this scan",
      },
      findings,
    };
  }
  const reason = finding?.detail ?? "scanner did not return a valid Socket policy verdict";
  return {
    run: {
      ...(stopped ?? { id: scanner.id, status: "error" }),
      findings: findings.length,
      reason: stopped?.reason ?? reason,
      reportGap: stopped ? "partial" : (reportGap ?? "partial"),
    },
    findings,
  };
}

function socketVerdictMatchesExit(process: ScannerProcess, verdict: boolean | undefined): boolean {
  if (process.noNumericExitStatus) return false;
  return process.ok ? verdict === true : process.exitCode === 1 && verdict === false;
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
  const settled = settleReport(scanner.id, outcome, problems);
  return applyScannerEvidence(settled, declaredEvidence(scanner, process));
}

function declaredEvidence(
  scanner: ScannerDef,
  process: ScannerProcess,
): ScannerEvidence | undefined {
  if (process.evidence || !scanner.evidence) return process.evidence;
  return {
    status: "partial",
    reportGap: "missing",
    reason: "The scanner did not supply its required inventory",
  };
}

function missingInventoryFindings(
  settled: SettledScan,
  required: InventoryFinding[] = [],
): boolean {
  if (required.length === 0) return false;
  const reported = new Map<string, Set<string>>();
  for (const { name, detail } of settled.findings ?? []) {
    const group = reported.get(name) ?? new Set<string>();
    group.add(detail);
    reported.set(name, group);
  }
  for (const { name, version } of required) {
    const group = reported.get(name);
    const match =
      group && [...group].find((detail) => detail.includes(`version ${version} was found at:`));
    if (!group || !match) return true;
    group.delete(match);
  }
  return false;
}

function applyScannerEvidence(settled: SettledScan, evidence?: ScannerEvidence): SettledScan {
  if (!evidence) return settled;
  const run = settled.run;
  if (evidence.status === "complete") {
    const scoped = {
      ...run,
      ...(evidence.packageCount === undefined ? {} : { packageCount: evidence.packageCount }),
      ...(evidence.checkCount === undefined ? {} : { checkCount: evidence.checkCount }),
      ...(evidence.fileCount === undefined ? {} : { fileCount: evidence.fileCount }),
      ...(evidence.targetFiles === undefined ? {} : { targetFiles: evidence.targetFiles }),
    };
    if (run.status === "ran" && missingInventoryFindings(settled, evidence.requiredFindings))
      return {
        ...settled,
        run: {
          ...scoped,
          status: "partial",
          reportGap: "partial",
          reason: "The inventory reports findings missing from the scanner report",
        },
      };
    return { ...settled, run: scoped };
  }
  if (run.status !== "ran") return settled;
  if (evidence.status === "not-applicable" && run.findings === 0)
    return {
      ...settled,
      run: { ...run, status: "not-applicable", noTarget: true, reason: evidence.reason },
    };
  const reportGap = evidence.status === "partial" ? evidence.reportGap : "partial";
  return { ...settled, run: { ...run, status: "partial", reportGap, reason: evidence.reason } };
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
