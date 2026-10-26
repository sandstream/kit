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

/**
 * The first lines of each failing test's own error, keyed by its top-level name. A suite's
 * "N subtests failed" is skipped for the nested error that explains it. The summary is the part of
 * a CI log a reader reliably reaches (logs are long, and readers see the tail), so an intermittent
 * failure has to explain itself there, not only in the TAP block thousands of lines above.
 * @param {string} tap @param {number} [maxLines] @returns {Record<string, string>}
 */
export function failureReasons(tap, maxLines = 8) {
  const reasons = {};
  for (const block of tap.split(/^(?=not ok \d+ - )/m)) {
    const head = /^not ok \d+ - (.+)$/m.exec(block);
    if (!head) continue;
    const errors = [...block.matchAll(/^(\s*)error: (.*)$/gm)].filter(
      (m) => !/subtests? failed/.test(m[2]),
    );
    if (errors.length === 0) continue;
    const [match, indent, first] = errors[0];
    const rest = block
      .slice(block.indexOf(match) + match.length)
      .split("\n")
      .slice(1);
    const body = first.trim() === "|-" ? [] : [first.replace(/^'|'$/g, "")];
    for (const line of rest) {
      if (!line.startsWith(`${indent}  `)) break;
      body.push(line.slice(indent.length + 2));
    }
    const text = body.filter((l) => l.trim().length > 0);
    reasons[head[1].trim()] = text.slice(0, maxLines).join("\n");
  }
  return reasons;
}

/**
 * @param {{ timeouts: string[], failures: string[] }} kinds @param {number} timeoutMs
 * @param {Record<string, string>} [reasons] from failureReasons(); printed under each failure
 */
export function describeFailureKinds(kinds, timeoutMs, reasons = {}) {
  const lines = [
    ...kinds.timeouts.map(
      (n) => `  timed out: ${n} (over ${timeoutMs}ms; hung, not asserted wrong)`,
    ),
    ...kinds.failures.map((n) => `  failed: ${n}`),
  ];
  if (lines.length === 0) return "";
  const detailed = lines.map((line, i) => {
    const name = i < kinds.timeouts.length ? null : kinds.failures[i - kinds.timeouts.length];
    const why = name ? reasons[name] : undefined;
    return why ? `${line}\n${why.replace(/^/gm, "      ")}` : line;
  });
  return `[kit] ${lines.length} not ok:\n${detailed.join("\n")}`;
}
