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
  // node prints a test's subtests BEFORE its own `not ok` line, then the test's own YAML after it.
  // So for each top-level failure, look first at its own error, and when that is only
  // "N subtests failed", at the nested block printed just above it.
  const reasons = {};
  const lines = tap.split("\n");
  let blockStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const head = /^(not )?ok \d+ - (.+)$/.exec(lines[i]);
    if (!head) continue;
    if (head[1]) {
      let end = i + 1;
      while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]))) end++;
      const why =
        firstError(lines.slice(i + 1, end), maxLines) ??
        firstError(lines.slice(blockStart, i), maxLines);
      if (why) reasons[head[2].trim()] = why;
    }
    blockStart = i + 1;
  }
  return reasons;
}

/** The first `error:` in a slice of TAP lines that is not a suite's subtest count, as text. */
function firstError(lines, maxLines) {
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)error: (.*)$/.exec(lines[i]);
    if (!m || /subtests? failed/.test(m[2])) continue;
    const [, indent, first] = m;
    const body = first.trim() === "|-" ? [] : [first.replace(/^'|'$/g, "")];
    for (const line of lines.slice(i + 1)) {
      if (!line.startsWith(`${indent}  `)) break;
      body.push(line.slice(indent.length + 2));
    }
    const text = body.filter((l) => l.trim().length > 0);
    if (text.length > 0) return text.slice(0, maxLines).join("\n");
  }
  return undefined;
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
