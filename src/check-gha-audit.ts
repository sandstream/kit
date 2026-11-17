/**
 * `kit check`'s view of the repository's GitHub Actions workflows: the `kit gha-audit` workflow
 * rules (unpinned actions, pwn requests, skippable gates and the rest in src/gha-audit.ts).
 *
 * `kit check` never ran them, so a workflow that `kit gha-audit` warned on showed nothing in
 * `kit check --category security`. Only the local workflow scan runs here: it reads
 * `.github/workflows/*` and makes no network call. The branch-protection half of `kit gha-audit`
 * needs the GitHub API and stays out of `kit check`.
 */
import type { SecurityCheckResult } from "./check-security.js";

export async function checkGhaWorkflows(root: string): Promise<SecurityCheckResult[]> {
  const { runGhaAudit } = await import("./gha-audit.js");
  return runGhaAudit(root);
}
