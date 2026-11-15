/**
 * Pay python3's cold start once, before the tests that time a `triage.py` run.
 *
 * Those tests give each run 30 s so that a hung script fails instead of stalling the shard. On a
 * fresh Windows runner the FIRST python3 process of the job can take longer than that before
 * triage.py's own code starts. Measured on kit#840, where a re-split put
 * `triage-py-redaction` first in its shard: 30,060 ms (killed), then 10,763 ms, then 121 ms for
 * three runs of the same script. In the shard where other python tests had run first, the same
 * three runs took 221 ms, 90 ms and a few ms.
 *
 * The timeout is there to catch a hang in triage.py, not the interpreter's first start. So each
 * file calls this in `before`. It imports the same standard modules triage.py does, with a
 * generous limit, and prints how long the start took when that was slow, so the log shows the
 * cost instead of hiding it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Long enough for a cold interpreter under a loaded shard, short of the 600 s per-file limit. */
const WARMUP_TIMEOUT_MS = 180_000;
/** Below this, the start was warm and is not worth a line in the log. */
const REPORT_ABOVE_MS = 5_000;

let warm: Promise<void> | undefined;

/**
 * Start python3 once per test process. Never throws: when python3 is absent or fails, the test's
 * own run reports it (and skips loudly when python3 is missing).
 */
export function warmPython(): Promise<void> {
  warm ??= (async () => {
    const started = Date.now();
    try {
      await exec(
        "python3",
        ["-I", "-c", "import json, re, urllib.error, urllib.parse, urllib.request, datetime"],
        { timeout: WARMUP_TIMEOUT_MS },
      );
    } catch {
      return;
    }
    const ms = Date.now() - started;
    if (ms > REPORT_ABOVE_MS) {
      process.stderr.write(`[warmPython] python3 cold start took ${ms} ms\n`);
    }
  })();
  return warm;
}
