/**
 * The finding for a scanner whose own exit status is its verdict (Socket's `ci`). Any non-zero exit
 * stays a high finding, so a broken run is never green. What the finding SAYS depends on the cause:
 * a refused token is a setup problem, not a policy result, and sending the reader to a dashboard
 * for policy issues would send them looking for vulnerable packages when the fix is a token.
 */
import type { SecurityCheckResult } from "./check-security.js";

const AUTH_CODES = new Set([401, 403]);
const AUTH_TEXT = /request failed \((401|403)\)/;

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
  const refused = refusedWith(out);
  if (refused !== undefined) {
    return {
      category: "supply-chain",
      name: `${id}: scan could not run`,
      status: "fail",
      detail: `${id} ci could not run: the API refused the token (HTTP ${refused}). Check ${scanner.needsToken ?? "the API token"}. This is not a policy result`,
      severity: "high",
    };
  }
  return {
    category: "supply-chain",
    name: `${id}: ci exited non-zero`,
    status: "fail",
    detail: `${id} ci exited non-zero: dependency policy issues were found, or the scan did not finish (see the ${id} dashboard)`,
    severity: "high",
  };
}
