import {
  checkEnvIgnoreProtection,
  confirmsEnvIgnoreProtection,
  type IgnoreCheckResult,
} from "./check-gitignore.js";
import type { SecurityCheckResult } from "./check-security.js";

type EnvIgnoreInspector = (root: string) => Promise<IgnoreCheckResult | null>;

const check = { category: "secrets", name: ".env gitignored" } as const;
const unverified = { ...check, severity: "medium", didNotRun: true } as const;

/** Verify Git ignore protection and derive the verdict in Kit. */
export async function checkEnvGitignored(
  root: string,
  inspect: EnvIgnoreInspector | null = checkEnvIgnoreProtection,
): Promise<SecurityCheckResult> {
  if (!inspect) {
    return { ...unverified, status: "fail", detail: "Git ignore inspection is unavailable" };
  }
  try {
    const report = await inspect(root);
    if (!report || !Array.isArray(report.missingPatterns)) {
      return { ...unverified, status: "fail", detail: "Git ignore inspection is incomplete" };
    }
    if (report.missingPatterns.length === 0) {
      if (!confirmsEnvIgnoreProtection(report)) {
        return { ...unverified, status: "fail", detail: "Git ignore inspection is incomplete" };
      }
      return {
        ...check,
        status: "pass",
        detail: "Git ignores dotenv probe paths; no exposed or tracked dotenv secret files",
      };
    }
    return {
      ...check,
      status: "fail",
      detail: report.missingPatterns
        .map((entry) => `${JSON.stringify(entry.pattern)}: ${entry.reason}`)
        .join("; "),
      files: [...new Set([...report.trackedFiles, ...report.unignoredFiles])],
      severity: "high",
      suggestion:
        "Run kit fix for ignore rules. Review already tracked files separately; ignore rules cannot untrack them.",
    };
  } catch (error) {
    return {
      ...unverified,
      status: "warn",
      detail:
        error instanceof Error ? error.message : "Git ignore protection could not be verified",
    };
  }
}
