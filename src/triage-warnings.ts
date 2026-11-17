/**
 * Triage warnings on a PASSING install.
 *
 * `kit triage` can pass a package and still warn about it: a release inside the cooling period,
 * no declared licence, a very new package. A person running `kit triage` reads those lines. The
 * install gate (`kit gate-bash`) and `kit install` used to drop them, so an agent installing
 * through the gate never saw them. These helpers pull the warnings out of the triage report and
 * format them as plain stderr lines; the verdict and the exit code do not change.
 */

/** Control characters (C0, DEL, C1) that must not reach a terminal from registry-supplied text. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The text of every `! WARNING:` line in a triage report, in order, without the marker.
 * Control characters are replaced with a space: a warning can quote registry data.
 */
export function triageWarnings(output: string): string[] {
  const out: string[] = [];
  for (const raw of output.split("\n")) {
    const at = raw.indexOf("! WARNING:");
    if (at === -1 || raw.slice(0, at).trim() !== "") continue;
    const text = raw
      .slice(at + "! WARNING:".length)
      .replace(CONTROL, " ")
      .trim();
    if (text) out.push(text);
  }
  return out;
}

/** The part of a verdict these helpers read. */
export interface WarnedVerdict {
  tool: string;
  decision: "pass" | "blocked";
  warnings?: string[];
}

/** One plain line per warning of each passing verdict: `<label>: warning: <tool>: <text>`. */
export function passWarningLines(label: string, verdicts: readonly WarnedVerdict[]): string[] {
  const lines: string[] = [];
  for (const v of verdicts) {
    if (v.decision !== "pass") continue;
    for (const w of v.warnings ?? []) lines.push(`${label}: warning: ${v.tool}: ${w}`);
  }
  return lines;
}

/** Write {@link passWarningLines} to stderr (fd 2, synchronously: the caller may exit next). */
export async function writePassWarnings(
  label: string,
  verdicts: readonly WarnedVerdict[],
): Promise<void> {
  const lines = passWarningLines(label, verdicts);
  if (lines.length === 0) return;
  const { writeSync } = await import("node:fs");
  writeSync(2, `${lines.join("\n")}\n`);
}

/** `{ warnings }` when the report has any, else `{}`: spread into a passing verdict. */
export function warningsField(output: string): { warnings?: string[] } {
  const warnings = triageWarnings(output);
  return warnings.length > 0 ? { warnings } : {};
}

/** `kit install`'s results, as far as the warning lines need them. */
export interface WarnedInstall {
  name: string;
  warnings?: string[];
}

/** `kit install`: print each passed tool's triage warnings as plain stderr lines. */
export function writeInstallWarnings(results: readonly WarnedInstall[]): void {
  for (const r of results) {
    for (const w of r.warnings ?? [])
      process.stderr.write(`kit install: warning: ${r.name}: ${w}\n`);
  }
}
