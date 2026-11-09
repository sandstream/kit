/**
 * Cross-check between the scanners of the general standards gate. A scanner that exits 0 with
 * an empty report looks the same as a clean project. When another engine measured at least one
 * function body, the project is not empty, so an empty file list from scc or a jscpd report
 * without a positive source count is incomplete evidence, not a pass.
 *
 * Limit: when every scanner returns nothing, this check has no witness and the reports are
 * accepted as an empty project. docs/CODE_METRICS.md states that limit.
 */
import type { GeneralScan } from "./standards-general-scan.js";

/** Source count from a jscpd report: a non-negative integer, or undefined when absent or invalid. */
export function jscpdSourceCount(jsonText: string): number | undefined {
  try {
    const sources = JSON.parse(jsonText)?.statistics?.total?.sources;
    return typeof sources === "number" && Number.isSafeInteger(sources) && sources >= 0
      ? sources
      : undefined;
  } catch {
    return undefined;
  }
}

export function crossCheckScan(
  scan: GeneralScan,
  duplicationSources: number | undefined,
): GeneralScan {
  if (scan.complexity.didNotRun) return scan;
  const measured = new Set(scan.complexity.findings.map((finding) => finding.file)).size;
  if (measured === 0) return scan;
  const witness = `${measured} file(s) hold measured functions`;
  let { size, duplication } = scan;
  if (!size.didNotRun && size.findings.length === 0) {
    size = {
      findings: [],
      didNotRun: true,
      issue: `scc listed no file, but ${witness}. File size remains unverified.`,
    };
  }
  if (!duplication.didNotRun && !duplicationSources) {
    duplication = {
      report: { percentage: 0, pairs: [] },
      didNotRun: true,
      issue: `jscpd reported no analysed source, but ${witness}. Duplication remains unverified.`,
    };
  }
  return { ...scan, size, duplication };
}
