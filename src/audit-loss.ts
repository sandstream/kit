/**
 * A lost audit event is never silent.
 *
 * An append to the audit log can fail: the write lock times out, the disk is full, the log is
 * damaged. The append functions report that with a boolean and one line on stderr. Callers
 * that gate an operation on the log check the boolean. Other callers record an action that
 * has already happened, and they cannot undo it, so they go on. Before this module such a run
 * ended with exit code 0, and nothing that reads only the exit code could tell that the
 * record was incomplete.
 *
 * This module counts the losses. When the process ends it says how many events were lost and
 * turns a success exit code into a failure. The operation is not stopped: stopping is the
 * caller's decision, and for an action that has already happened there is nothing to stop.
 */
import { writeSync } from "node:fs";

/** Exit code of a run that did its work but did not record all of it. */
const AUDIT_LOSS_EXIT_CODE = 1;

let lostEvents = 0;

function reportAtExit(code: number): void {
  const message =
    lostEvents === 1
      ? "1 audit event was not recorded"
      : `${lostEvents} audit events were not recorded`;
  try {
    // A synchronous write: an exit listener cannot wait for a stream to drain.
    writeSync(2, `[kit] ${message}. This run is not fully audited; the cause is printed above.\n`);
  } catch {
    // stderr is closed. The exit code below still carries the result.
  }
  // Only a success code changes. A gate that refused with its own code keeps that code.
  if (code === 0) process.exitCode = AUDIT_LOSS_EXIT_CODE;
}

/** Count one audit event that could not be written to the local log. */
export function recordAuditLoss(): void {
  lostEvents += 1;
  if (lostEvents === 1) process.once("exit", reportAtExit);
}
