/**
 * `kit triage skill <local path>` also runs the instruction rules over the skill's files.
 *
 * Skill triage checked frontmatter and secrets, in Python, and printed a health score. The
 * instruction rules (`kit triage instructions`) are a separate command. On a pack of 79 offensive
 * security skills the first printed 100/100, TRIAGE PASSED, and the second printed 66 findings in
 * the same files (kit-research `claude-red-vs-kit`). A `SKILL.md` is text an agent follows, so the
 * skill report now carries the count and the rules that fired.
 *
 * The verdict and the score are not changed: the rules are pattern matches that cannot tell a
 * line that describes an attack from one that performs it, and this module says so in its output.
 */
import { existsSync, statSync } from "node:fs";

import { scanInstructions } from "./instruction-scan.js";

const SHOWN_RULES = 6;

function countBy(values: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** The lines to print under a local skill triage, or null when the target is not a local path. */
export function skillInstructionLines(target: string): string[] | null {
  if (!existsSync(target)) return null;
  let isDir: boolean;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    return null;
  }
  const scan = scanInstructions(target, isDir);
  const head = "Instruction rules (the same files, read as text an agent follows):";
  if (scan.files.length === 0) return [head, "  no agent instruction file found"];
  const read = scan.files.length - scan.unread.length;
  const partial = scan.complete ? "" : "; the scan was incomplete, so this is a lower bound";
  if (scan.findings.length === 0) {
    return [head, `  no finding in ${read} file(s) read${partial} (a floor, not a guard)`];
  }
  const files = new Set(scan.findings.map((f) => f.file)).size;
  const rules = countBy(scan.findings.map((f) => f.rule));
  const more = rules.length > SHOWN_RULES ? `, +${rules.length - SHOWN_RULES} more rule(s)` : "";
  const list = rules
    .slice(0, SHOWN_RULES)
    .map(([rule, n]) => `${n} ${rule}`)
    .join(", ");
  return [
    head,
    `  ! ${scan.findings.length} finding(s) in ${files} of ${read} file(s) read${partial}: ${list}${more}`,
    "  The score and verdict above do not count these: a rule cannot tell a line that describes an",
    "  attack from one that carries it out. Read them: kit triage instructions <path>",
  ];
}
