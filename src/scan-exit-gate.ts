/**
 * Read the policy verdict and distinguish it from a failed Socket invocation.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { reportText, scannerObject, scannerRecord } from "./check-scanner-evidence.js";

const AUTH_CODES = new Set([401, 403]);
const AUTH_TEXT = /request failed \((401|403)\)/;

interface SocketPolicy {
  verdict?: boolean;
  reportedViolation: boolean;
  reportGap?: "missing" | "malformed";
}

// The CI report groups alerts by ecosystem, package and version.
function readAlerts(value: unknown, depth: number): { valid: boolean; hasViolation: boolean } {
  if (!scannerRecord(value)) return { valid: false, hasViolation: false };
  if (depth === 0) {
    const isViolation = value.policy === "error" && reportText(value.type);
    return { valid: isViolation, hasViolation: isViolation };
  }
  const entries = Object.values(value);
  let valid = depth === 3 || entries.length > 0;
  let hasViolation = false;
  for (const entry of entries) {
    const child = readAlerts(entry, depth - 1);
    valid &&= child.valid;
    hasViolation ||= child.hasViolation;
  }
  return { valid, hasViolation };
}

export function readSocketPolicy(stdout: string): SocketPolicy {
  const report = scannerObject(stdout);
  const data = report?.data;
  if (report?.ok !== true || !scannerRecord(data)) {
    return { reportedViolation: false, reportGap: socketFailureGap(stdout, report) };
  }
  const alerts = readAlerts(data.alerts, 3);
  const { healthy, options } = data;
  const reportedViolation = healthy === false || alerts.hasViolation;
  if (
    !alerts.valid ||
    healthy !== !alerts.hasViolation ||
    data.includeLicensePolicy !== true ||
    !reportText(data.orgSlug) ||
    !reportText(data.scanId) ||
    !scannerRecord(options) ||
    options.fold !== "version" ||
    options.reportLevel !== "error"
  ) {
    return { reportedViolation };
  }
  return { verdict: healthy, reportedViolation };
}

function socketFailureGap(
  stdout: string,
  report: Record<string, unknown> | undefined,
): "missing" | "malformed" {
  if (!stdout.trim()) return "missing";
  if (report?.ok !== false || !reportText(report.message)) return "malformed";
  // Socket reports invalid upstream scan data in a valid error envelope.
  return report.message === "Invalid Socket API response" ? "malformed" : "missing";
}

function jsonCode(stdout: string): number | undefined {
  try {
    const code = (JSON.parse(stdout) as { data?: { code?: unknown } }).data?.code;
    return typeof code === "number" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** The HTTP status that refused the token, when the output says so. */
function refusedWith(out: { stdout: string; stderr?: string }): number | undefined {
  const code = jsonCode(out.stdout);
  if (code !== undefined) return AUTH_CODES.has(code) ? code : undefined;
  const text = AUTH_TEXT.exec(`${out.stdout}\n${out.stderr ?? ""}`);
  return text ? Number(text[1]) : undefined;
}

export function exitGateFinding(
  scanner: { id: string; needsToken?: string },
  out: { ok: boolean; stdout: string; stderr?: string },
  reportedViolation: boolean,
): SecurityCheckResult {
  const id = scanner.id;
  if (reportedViolation) {
    return {
      category: "supply-chain",
      name: out.ok ? `${id}: inconsistent policy report` : `${id}: ci exited non-zero`,
      status: "fail",
      detail: `${id} ci reported a dependency policy violation (see the ${id} dashboard)`,
      severity: "high",
    };
  }
  const refused = refusedWith(out);
  if (refused !== undefined) {
    return {
      category: "supply-chain",
      name: `${id}: scan could not run`,
      status: "fail",
      detail: `${id} ci could not run: the API refused the token (HTTP ${refused}). Check ${scanner.needsToken ?? "the API token"}. This is not a policy result`,
      severity: "high",
      didNotRun: true,
    };
  }
  return {
    category: "supply-chain",
    name: `${id}: scan did not finish`,
    status: "fail",
    detail: `${id} ci exited non-zero and did not finish with a valid policy report`,
    severity: "high",
    didNotRun: true,
  };
}
