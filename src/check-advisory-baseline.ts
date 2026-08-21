/**
 * The `kit check` face of the advisory baseline: fail on new debt, and on a baseline that has
 * stopped matching reality.
 *
 * Kept separate from the mechanics in `advisory-baseline.ts` so the rules can be tested without
 * running a package manager, and so the verdict logic is readable on its own.
 */

import type { SecurityCheckResult } from "./check-security.js";
import {
  ADVISORY_BASELINE_FILE,
  detectAuditRunner,
  readBaseline,
  runAudit,
  diffAgainstBaseline,
  describeRemaining,
  worstSeverity,
  type Severity,
} from "./advisory-baseline.js";

const NAME = "advisory baseline";

/** kit's own severity vocabulary does not have "moderate"/"info". */
function toKitSeverity(s: Severity | null): SecurityCheckResult["severity"] {
  if (s === "critical") return "critical";
  if (s === "high") return "high";
  if (s === "moderate") return "medium";
  return "low";
}

export async function checkAdvisoryBaseline(root: string): Promise<SecurityCheckResult> {
  const base: Omit<SecurityCheckResult, "status" | "detail"> = {
    category: "dependency",
    name: NAME,
  };

  const baseline = await readBaseline(root);
  if (!baseline) {
    // Opt-in by construction: without a committed baseline there is no "new" to compare against.
    // A skip with the command to adopt it, not a warning about a choice nobody has made yet.
    return {
      ...base,
      status: "skip",
      detail: `no ${ADVISORY_BASELINE_FILE} — freeze today's debt with \`kit security advisories --accept\``,
    };
  }

  if (["1", "true", "yes"].includes((process.env.KIT_AIRGAP ?? "").trim().toLowerCase())) {
    return {
      ...base,
      status: "skip",
      detail: "air-gap posture: an advisory audit needs the registry",
    };
  }

  const runner = await detectAuditRunner(root);
  if (!runner) {
    return { ...base, status: "skip", detail: "no lockfile — nothing to audit against" };
  }

  const outcome = runAudit(root, runner);
  if (outcome.error) {
    // A scan that could not run is not a clean scan. didNotRun makes the CI gate treat it that way.
    return {
      ...base,
      status: "fail",
      severity: "medium",
      didNotRun: true,
      detail: outcome.error,
    };
  }

  const { added, stale, remaining } = diffAgainstBaseline(outcome.advisories, baseline);

  if (added.length > 0) {
    const worst = worstSeverity(added);
    const list = added
      .slice(0, 3)
      .map((a) => `${a.package} ${a.id} (${a.severity})`)
      .join("; ");
    return {
      ...base,
      status: "fail",
      severity: toKitSeverity(worst),
      detail: `${added.length} NEW advisory(ies) since the baseline: ${list}${added.length > 3 ? `; +${added.length - 3}` : ""} — known debt: ${describeRemaining(remaining)}`,
      suggestion:
        "Fix or upgrade the dependency. If it must ship as known debt, record it deliberately: `kit security advisories --accept`.",
    };
  }

  if (stale.length > 0) {
    // The rule that keeps the file honest. Without it the list only grows, and a baseline nobody
    // prunes turns the gate into decoration.
    return {
      ...base,
      status: "fail",
      severity: "low",
      detail: `${stale.length} baseline entr${stale.length === 1 ? "y no longer applies" : "ies no longer apply"} (${stale
        .slice(0, 3)
        .map((s) => s.id)
        .join(", ")}${stale.length > 3 ? ", …" : ""}) — the file may only shrink`,
      suggestion:
        "The advisory is gone, so the line must go with it: `kit security advisories --accept` prunes it. Fixing a vulnerability and pruning its line belong in the same commit.",
    };
  }

  return {
    ...base,
    status: "pass",
    detail: `no new advisories (${outcome.manager}); known debt: ${describeRemaining(remaining)}`,
  };
}
