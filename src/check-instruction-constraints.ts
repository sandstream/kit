/**
 * `kit check` rows for instruction constraints, beside `instruction-file secrets`:
 *   - `instruction rules naming missing code`: a rule line ("never", "do not", "always", "only", …)
 *     in an agent instruction file names a path, function or env var in backticks that the tree
 *     no longer has;
 *   - `instruction rules removed since HEAD`: a committed rule line the working tree dropped, or
 *     softened from "never" to "avoid" or "prefer not".
 *
 * Both read kit's one instruction-file list, so they cover Claude Code, Codex, Cursor, Gemini CLI,
 * Copilot and Windsurf alike. Both are warnings: a text diff and a lookup, not a judgement of
 * whether the change was right (kit-research shrink-anything-vs-kit). No model (ADR-0001).
 */
import type { SecurityCheckResult } from "./check-security.js";
import {
  compareWithHead,
  scanConstraints,
  type DanglingRef,
} from "./instruction-constraints-repo.js";
import type { RuleChange } from "./instruction-constraints.js";

const HARNESSES = "Claude Code, Codex, Cursor, Gemini CLI, Copilot, Windsurf";
const SHOWN = 10;
const BASE = { category: "governance" } as const;

const EVIDENCE: Record<DanglingRef["evidence"], string> = {
  missing: "not in the tree",
  removed: "in HEAD, gone from the working tree",
  deleted: "deleted, still in git history",
};

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

function danglingRow(root: string): SecurityCheckResult {
  const NAME = "instruction rules naming missing code";
  const scan = scanConstraints(root);
  if (scan.files === 0 && scan.incomplete.length === 0) {
    return {
      ...BASE,
      name: NAME,
      status: "skip",
      detail: "no agent instruction files in the project",
    };
  }
  const scope = `${plural(scan.ruleLines, "rule line")} in ${plural(scan.files, "instruction file")}, ${plural(scan.checked, "code token")}`;
  const note = scan.incomplete.length ? `; scan incomplete: ${scan.incomplete.join(", ")}` : "";
  const partial = scan.incomplete.length ? { scanIncomplete: true as const } : {};
  if (scan.dangling.length) {
    return {
      ...BASE,
      ...partial,
      name: NAME,
      status: "warn",
      severity: "low",
      hasFindings: true,
      detail: `${plural(scan.dangling.length, "rule reference")} name code that is gone (${scope})${note}`,
      files: scan.dangling
        .slice(0, SHOWN)
        .map((d) => `${d.file}:${d.line} \`${d.token}\` (${EVIDENCE[d.evidence]})`),
      suggestion:
        "Update or delete each listed rule: it constrains code that no longer exists, so it protects nothing. If the code was removed by mistake, restore it.",
    };
  }
  if (scan.incomplete.length) {
    return {
      ...BASE,
      ...partial,
      name: NAME,
      status: "warn",
      detail: `nothing missing found (${scope})${note}`,
    };
  }
  return { ...BASE, name: NAME, status: "pass", detail: `${scope}: none missing (${HARNESSES})` };
}

function describeChange(c: RuleChange): string {
  if (c.kind === "weakened") return `${c.file}:${c.line} weakened from "${c.from}": ${c.to}`;
  return `${c.file}:${c.line} removed: ${c.excerpt}`;
}

function headRow(root: string): SecurityCheckResult {
  const NAME = "instruction rules removed since HEAD";
  const cmp = compareWithHead(root);
  if (!cmp.compared) {
    return { ...BASE, name: NAME, status: "skip", detail: "no git commit to compare with" };
  }
  const note = cmp.incomplete.length ? `; not compared: ${cmp.incomplete.join(", ")}` : "";
  const partial = cmp.incomplete.length ? { scanIncomplete: true as const } : {};
  const changed = plural(cmp.changedFiles.length, "changed instruction file");
  if (cmp.changes.length) {
    return {
      ...BASE,
      ...partial,
      name: NAME,
      status: "warn",
      severity: "low",
      hasFindings: true,
      detail: `${plural(cmp.changes.length, "committed rule line")} removed or weakened in ${changed} (line numbers are HEAD's)${note}`,
      files: cmp.changes.slice(0, SHOWN).map(describeChange),
      suggestion:
        "Confirm each removal was meant. A compressor, an agent edit or a block rewrite can drop a rule nobody chose to drop; restore it with `git diff HEAD -- <file>`.",
    };
  }
  if (cmp.incomplete.length) {
    return {
      ...BASE,
      ...partial,
      name: NAME,
      status: "warn",
      detail: `nothing removed found in ${changed}${note}`,
    };
  }
  return {
    ...BASE,
    name: NAME,
    status: "pass",
    detail: `no rule line removed or weakened in ${changed}`,
  };
}

/** Both rows for the project at `root`. */
export function checkInstructionConstraints(root: string): SecurityCheckResult[] {
  return [danglingRow(root), headRow(root)];
}
