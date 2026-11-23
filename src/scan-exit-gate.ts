/**
 * Read the policy verdict and distinguish it from a failed Socket invocation.
 */
import type { SecurityCheckResult } from "./check-security.js";
import { scannerObject, scannerRecord } from "./check-scanner-evidence.js";

const AUTH_CODES = new Set([401, 403]);
const AUTH_TEXT = /request failed \((401|403)\)/;

export function socketPolicyVerdict(stdout: string): boolean | undefined {
  const report = scannerObject(stdout);
  const data = report?.data;
  if (report?.ok !== true || !scannerRecord(data)) return undefined;
  return typeof data.healthy === "boolean" ? data.healthy : undefined;
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
  out: { stdout: string; stderr?: string },
): SecurityCheckResult {
  const id = scanner.id;
  if (socketPolicyVerdict(out.stdout) === false) {
    return {
      category: "supply-chain",
      name: `${id}: ci exited non-zero`,
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
