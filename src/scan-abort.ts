import type { ScannerRun } from "./scanners.js";

/** How long a scanner may run when its definition sets no limit of its own. */
export const DEFAULT_SCAN_TIMEOUT_MS = 180_000;

/**
 * A run that kit itself cut short is not the scanner's failure, and it is not "found nothing". Say
 * which limit it hit. The scanner's last stderr line must not stand in for the reason: osv-scanner
 * always prints a harmless "may be risky" warning, so that line sat next to a killed run as if it
 * explained it.
 */
export function abortedRun(
  scanner: { id: string; timeoutMs?: number },
  res: { timedOut?: boolean; truncated?: boolean },
): ScannerRun | undefined {
  const run = (reason: string): ScannerRun => ({
    id: scanner.id,
    status: "error",
    findings: 0,
    reason,
  });
  if (res.truncated) {
    return run(
      "output exceeded kit's buffer limit and was cut off, so the report was not read (a kit limit, not a scanner error)",
    );
  }
  if (!res.timedOut) return undefined;
  const seconds = (scanner.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS) / 1000;
  return run(
    `timed out after ${seconds} s and was stopped, so it found nothing to report (a kit time limit, not a scanner crash)`,
  );
}
