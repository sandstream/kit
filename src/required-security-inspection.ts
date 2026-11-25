import type { SecurityCheckResult } from "./check-security.js";

type InspectionFailure =
  { kind: "unavailable" | "incomplete" } | { kind: "failed"; error: unknown };

/** An inspector supplies evidence. The caller owns the check's verdict. */
export async function runRequiredInspection<Report>(
  inspect: (() => Report | null | Promise<Report | null>) | null,
  decide: (report: Report) => SecurityCheckResult | null,
  unverified: (failure: InspectionFailure) => SecurityCheckResult,
): Promise<SecurityCheckResult> {
  if (inspect === null) return unverified({ kind: "unavailable" });
  try {
    const report = await inspect();
    const verdict = report == null ? null : decide(report);
    return verdict ?? unverified({ kind: "incomplete" });
  } catch (error) {
    return unverified({ kind: "failed", error });
  }
}
