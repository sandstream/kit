import { c } from "../utils/colors.js";
import { identityRemediation, type ContextFinding } from "../context-lock.js";

function icon(f: ContextFinding): string {
  if (f.status === "ok") return `${c.green}✓${c.reset}`;
  if (f.status === "mismatch" || f.status === "unchecked") return `${c.red}✗${c.reset}`;
  return `${c.yellow}!${c.reset}`;
}

function detail(f: ContextFinding): string {
  if (f.status === "ok") return `${c.dim}${f.expected}${c.reset}`;
  if (f.status === "unchecked") {
    const what = f.field === "(section)" ? "tool" : "key";
    return `${c.yellow}declared but not checked: kit has no check for this ${what}${c.reset}`;
  }
  const actual = f.actual ?? `${c.dim}(unreadable)${c.reset}`;
  return `expected ${c.bold}${f.expected}${c.reset}, live ${c.bold}${actual}${c.reset}`;
}

function isIdentity(f: ContextFinding): boolean {
  return f.field === "user" || f.field === "account";
}

function printMismatches(mismatches: ContextFinding[]): void {
  console.log(
    `\n${c.red}${mismatches.length} mismatch(es) — you are NOT locked to the declared account/project. Do not run outward/destructive commands until this is green.${c.reset}`,
  );
  // An identity mismatch is not fixed by logging in again — a global login is what produced
  // it. Name the per-tool mechanism that scopes an identity to a repo (#503).
  const seen = new Set<string>();
  for (const f of mismatches.filter(isIdentity)) {
    const hint = identityRemediation(f.tool);
    if (hint && !seen.has(hint)) {
      seen.add(hint);
      console.log(`  ${c.dim}${hint}${c.reset}`);
    }
  }
  // A wrong identity does not merely mean "wrong account": the output of everything you ran
  // as it may have been a filtered subset, which is how this defect cost two wrong
  // conclusions in a row.
  if (mismatches.some(isIdentity)) {
    console.log(
      `  ${c.yellow}Anything you already read as this identity may have been a PARTIAL view — permissions filter listings silently.${c.reset}`,
    );
  }
}

/** Print the context lock table and its summaries. Returns true when nothing blocks. */
export function printContextReport(findings: ContextFinding[]): boolean {
  console.log(`${c.bold}Context lock${c.reset}\n`);
  for (const f of findings) console.log(`  ${icon(f)} ${f.tool}.${f.field}  ${detail(f)}`);
  const mismatches = findings.filter((f) => f.status === "mismatch");
  if (mismatches.length > 0) printMismatches(mismatches);
  const unchecked = findings.filter((f) => f.status === "unchecked");
  if (unchecked.length > 0) {
    console.log(
      `\n${c.red}${unchecked.length} declared value(s) are not checked by kit. A typo or an unsupported tool leaves the lock open while this reads green. Fix the name or remove the line.${c.reset}`,
    );
  }
  // Mismatch or unchecked = non-zero exit so this can gate a hook / agent before acting.
  // Unknown (tool absent / unreadable) does not block.
  return mismatches.length === 0 && unchecked.length === 0;
}
