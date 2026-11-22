import {
  reportText,
  scannerGap,
  scannerObject,
  type ScannerGap,
} from "./check-scanner-evidence.js";
import { execFileNoThrow, type ExecResult } from "./utils/execFileNoThrow.js";

const NOT_GIT_REPOSITORY =
  /^fatal: not a git repository(?: \(or any of the parent directories\)(?:: \.git)?)?\r?\n(?:Stopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\r?\n)?$/;
const TRUFFLEHOG_FINDINGS_EXIT = 183;
const TRUFFLEHOG_SUMMARY = "finished scanning";
const TRUFFLEHOG_EXIT_LOG = "exiting with code 183 because results were found";
const TRUFFLEHOG_HOOK_LOG =
  "Running as a pre-commit hook, overriding default flags for hook context";

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type HistoryScope =
  | { kind: "outside" }
  | { kind: "unknown"; gap: ScannerGap }
  | { kind: "repository"; hasContent: boolean; limit?: ScannerGap };

export async function gitHistoryScope(root: string): Promise<HistoryScope> {
  const options = { timeout: 5_000, cwd: root, env: { ...process.env, LC_ALL: "C" } };
  const scope = await execFileNoThrow("git", ["rev-list", "--max-count=1", "--all"], options);
  if (scope.exitCode === 128 && scope.stdout === "" && NOT_GIT_REPOSITORY.test(scope.stderr)) {
    return { kind: "outside" };
  }
  const gap = scannerGap({ count: 0 }, scope);
  if (gap) return { kind: "unknown", gap };
  if (
    scope.stderr ||
    (scope.stdout && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})\r?\n$/.test(scope.stdout))
  ) {
    return {
      kind: "unknown",
      gap: { status: "malformed", reason: "Git returned unexpected history scope evidence" },
    };
  }
  const hasContent = scope.stdout !== "";
  return { kind: "repository", hasContent, limit: await historyScopeLimit(options) };
}

async function historyScopeLimit(options: {
  timeout: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ScannerGap | undefined> {
  const result = await execFileNoThrow("git", ["rev-parse", "--is-shallow-repository"], options);
  if (!result.ok || result.stderr || !/^(true|false)\r?\n$/.test(result.stdout)) {
    return { status: "partial", reason: "Git could not confirm the history depth" };
  }
  if (result.stdout.startsWith("true")) {
    return {
      status: "partial",
      reason: "a shallow clone exposes only part of the Git history reachable from local refs",
    };
  }
  return undefined;
}

interface HistoryFindingCounts {
  verified: number;
  unverified: number;
  malformed: boolean;
}

function trufflehogSummaryGap(
  summary: Record<string, unknown> | undefined,
  findings: HistoryFindingCounts,
  usedFindingsExit: boolean,
): ScannerGap | undefined {
  if (summary?.msg !== TRUFFLEHOG_SUMMARY) {
    return { status: "missing", reason: "TruffleHog returned no completion record" };
  }
  if (
    summary.level !== "info-0" ||
    !reportText(summary.trufflehog_version) ||
    !isCount(summary.chunks) ||
    !isCount(summary.bytes) ||
    !isCount(summary.verified_secrets) ||
    !isCount(summary.unverified_secrets)
  ) {
    return { status: "malformed", reason: "TruffleHog returned an invalid completion record" };
  }
  if (summary.chunks === 0 || summary.bytes === 0) {
    return { status: "partial", reason: "TruffleHog reported zero coverage for committed content" };
  }
  if (
    summary.verified_secrets !== findings.verified ||
    summary.unverified_secrets !== findings.unverified ||
    usedFindingsExit !== findings.verified + findings.unverified > 0
  ) {
    return {
      status: "partial",
      reason: "TruffleHog findings did not match its completion record and exit status",
    };
  }
  return undefined;
}

function trufflehogReportGap(
  scan: ExecResult,
  findings: HistoryFindingCounts,
): ScannerGap | undefined {
  if (findings.malformed || (scan.stdout && !scan.stdout.endsWith("\n"))) {
    return { status: "malformed", reason: "TruffleHog returned invalid finding records" };
  }

  // JSON mode writes findings to stdout and the completion record to stderr.
  const logs = scan.stderr.split(/\r?\n/);
  if (logs.pop() !== "")
    return { status: "malformed", reason: "TruffleHog diagnostics were incomplete" };
  const exitLog = scannerObject(logs.at(-1) ?? "");
  if (exitLog?.msg === TRUFFLEHOG_EXIT_LOG && scan.exitCode === TRUFFLEHOG_FINDINGS_EXIT) {
    logs.pop();
  }
  const finalLog = logs.pop();
  const summary = scannerObject(finalLog ?? "");
  if (finalLog !== undefined && !summary) {
    return { status: "malformed", reason: "TruffleHog returned invalid diagnostics" };
  }
  if (logs.some(unexpectedTrufflehogLog)) {
    return { status: "partial", reason: "TruffleHog reported unexpected diagnostics" };
  }
  return trufflehogSummaryGap(summary, findings, scan.exitCode === TRUFFLEHOG_FINDINGS_EXIT);
}

function unexpectedTrufflehogLog(line: string): boolean {
  const log = scannerObject(line);
  return (
    !log ||
    !/^info-[012]$/.test(String(log.level)) ||
    !reportText(log.msg) ||
    log.msg === TRUFFLEHOG_SUMMARY ||
    log.msg === TRUFFLEHOG_HOOK_LOG ||
    log.error != null ||
    /^(fatal|error):/i.test(String(log.msg))
  );
}

export function trufflehogHistoryGap(
  scan: ExecResult,
  findings: HistoryFindingCounts,
): ScannerGap | undefined {
  const count = findings.verified + findings.unverified;
  const executionGap = scannerGap({ count }, scan, { findings: TRUFFLEHOG_FINDINGS_EXIT });
  if (executionGap) return executionGap;
  const gap = trufflehogReportGap(scan, findings);
  return gap && count > 0 ? { ...gap, status: "partial" } : gap;
}

export interface BasicSecretMatch {
  file: string;
  content: string;
}

export function readBasicSecretGrep(process: ExecResult): {
  matches: BasicSecretMatch[];
  gap?: ScannerGap;
} {
  const matches: BasicSecretMatch[] = [];
  // With -z -n, Git emits a NUL after the filename and the line number.
  const row = /([^\0]+)\0[1-9]\d*\0([^\n\0]*)\n/gy;
  let parsedLength = 0;
  for (const match of process.stdout.matchAll(row)) {
    matches.push({ file: match[1], content: match[2] });
    parsedLength = match.index + match[0].length;
  }
  if (grepNoMatch(process)) return { matches };

  const count = matches.length;
  const gap = scannerGap({ count }, process);
  if (gap) return { matches, gap };
  if (process.stderr || parsedLength !== process.stdout.length || count === 0) {
    return {
      matches,
      gap: {
        status: count > 0 ? "partial" : "malformed",
        reason: "Git grep returned unexpected output or diagnostics",
      },
    };
  }
  return { matches };
}

function grepNoMatch(scan: ExecResult): boolean {
  return (
    scan.exitCode === 1 &&
    !scan.noNumericExitStatus &&
    !scan.timedOut &&
    !scan.truncated &&
    !scan.didNotStart &&
    scan.stdout === "" &&
    scan.stderr === ""
  );
}
