import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { execFileNoThrow, failedDetail, type ExecResult } from "./utils/execFileNoThrow.js";
import { redactSecrets } from "./utils/redactSecrets.js";
import { resolveToolBin } from "./utils/resolveTool.js";

const PROBLEMATIC_LICENSES = ["GPL", "AGPL", "LGPL", "CPAL", "OSL", "EUPL"];
const BASE = { category: "supply-chain", name: "license check" } as const;

function unavailable(): SecurityCheckResult {
  return {
    ...BASE,
    status: "warn",
    detail: "license-checker not installed or not executable",
    severity: "low",
    suggestion: "Install license-checker through a triaged tool declaration, then re-run",
    didNotRun: true,
  };
}

function failureReason(result: ExecResult): string {
  const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim());
  const diagnostic = lines.find(
    (line) =>
      /^(?:npm\s+)?(?:error|err!?|fatal)\b/i.test(line) ||
      /^(?:[A-Za-z]+Error(?:\s+\[[A-Z_]+\])?:|E[A-Z][A-Z0-9_]+\b|permission denied\b)/.test(line),
  );
  const fallback = lines.find((line) => line && !/^(?:npm\s+)?warn(?:ing)?\b/i.test(line));
  return redactSecrets(diagnostic ?? fallback ?? lines.find(Boolean) ?? "").slice(0, 200);
}

function failure(result: ExecResult, invalidJson = false): SecurityCheckResult {
  const reason = failureReason(result);
  const base = invalidJson
    ? "license check failed: scanner output is not a valid license report"
    : `license check failed (exit ${result.exitCode})${reason ? `: ${reason}` : ""}`;
  return {
    ...BASE,
    status: "warn",
    detail: failedDetail(base, result),
    severity: "low",
    suggestion:
      "Run license-checker --json --production in the project and correct the reported error.",
    didNotRun: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scanVerdict(result: ExecResult): SecurityCheckResult {
  try {
    const packages: unknown = JSON.parse(result.stdout);
    if (!isRecord(packages)) return failure(result, true);
    const violations = Object.entries(packages).flatMap(([pkg, info]) => {
      if (!isRecord(info) || (info.licenses !== undefined && typeof info.licenses !== "string")) {
        throw new Error("invalid license entry");
      }
      const license = info.licenses ?? "";
      const problematic = PROBLEMATIC_LICENSES.some((name) => license.toUpperCase().includes(name));
      return problematic ? [`${pkg} (${license})`] : [];
    });
    if (violations.length === 0) {
      return { ...BASE, status: "pass", detail: "no problematic licenses found" };
    }
    const remainder = violations.length > 3 ? ` +${violations.length - 3} more` : "";
    return {
      ...BASE,
      status: "warn",
      detail: `${violations.length} copyleft license(s): ${violations.slice(0, 3).join(", ")}${remainder}`,
      severity: "medium",
    };
  } catch {
    return failure(result, true);
  }
}

/** Report license findings separately from a missing scanner or an incomplete scan. */
export async function checkLicenses(
  root: string,
  tools = { resolveToolBin, execFileNoThrow },
): Promise<SecurityCheckResult> {
  try {
    await access(resolve(root, "package.json"));
  } catch {
    return { ...BASE, status: "skip", detail: "no package.json found" };
  }
  const bin = await tools.resolveToolBin("license-checker");
  if (!bin) return unavailable();
  const result = await tools.execFileNoThrow(bin, ["--json", "--production"], {
    timeout: 120_000,
    cwd: root,
  });
  return result.ok ? scanVerdict(result) : failure(result);
}
