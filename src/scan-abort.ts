import type { ScannerRun, ScannerStatus } from "./scanners.js";

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
  const run = (status: ScannerStatus, reason: string): ScannerRun => ({
    id: scanner.id,
    status,
    findings: 0,
    reason,
  });
  if (res.truncated) {
    return run(
      "error",
      "output exceeded kit's buffer limit and was cut off, so the report was not read (a kit limit, not a scanner error)",
    );
  }
  if (!res.timedOut) return undefined;
  const seconds = (scanner.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS) / 1000;
  return run(
    "timed-out",
    `timed out after ${seconds} s and was stopped, so it found nothing to report (a kit time limit, not a scanner crash)`,
  );
}

/** A run to show as failed (red). Not-installed and no-token are gaps, not failures. */
export function isFailedRun(status: ScannerStatus): boolean {
  return status === "error" || status === "timed-out";
}
