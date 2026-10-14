// Classify a node:test TAP report so the runner can say "timed out" instead of a bare failure.
// node tags a per-test timeout with `failureType: 'testTimeoutFailure'` and counts it as
// "cancelled", not "fail", so a hung test used to look like an unexplained non-zero exit.

/** @param {string} tap @returns {{ timeouts: string[], failures: string[] }} */
export function classifyTap(tap) {
  const timeouts = [];
  const failures = [];
  const blocks = tap.split(/^(?=not ok \d+ - )/m);
  for (const block of blocks) {
    const head = /^not ok \d+ - (.+)$/m.exec(block);
    if (!head) continue;
    const name = head[1].trim();
    if (/failureType:\s*'testTimeoutFailure'/.test(block)) timeouts.push(name);
    else failures.push(name);
  }
  return { timeouts, failures };
}

/** @param {{ timeouts: string[], failures: string[] }} kinds @param {number} timeoutMs */
export function describeFailureKinds(kinds, timeoutMs) {
  const lines = [
    ...kinds.timeouts.map(
      (n) => `  timed out: ${n} (over ${timeoutMs}ms; hung, not asserted wrong)`,
    ),
    ...kinds.failures.map((n) => `  failed: ${n}`),
  ];
  return lines.length === 0 ? "" : `[kit] ${lines.length} not ok:\n${lines.join("\n")}`;
}
