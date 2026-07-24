/**
 * `kit adr` — ADR → gate. Enforce the machine-readable `kit-enforce` block of an
 * accepted Architecture Decision Record, cited back to the ADR. Design:
 * kit-research/docs/research/adr-as-enforced-rule-design.md.
 *
 *   kit adr list    every ADR + status + enforced / documented-only
 *   kit adr check   run accepted ADRs' rules over the repo (default): forbid_pattern,
 *                   require_pattern, and forbid_import (direct + transitive)
 *
 * kit never interprets ADR prose (off-charter); it enforces only the explicit
 * toml block. Only `accepted` ADRs gate; an accepted ADR with no rules is surfaced
 * as "documented, not enforced" — never silently green. A transitive forbid_import
 * that hits an unresolvable relative import is a `gap` (can't prove), not a pass.
 */
import { readFileSync as read, existsSync as exists } from "node:fs";
import { relative as rel, join as pathJoin } from "node:path";
import { c } from "../utils/colors.js";
import { walkSourceFiles } from "../source-walk.js";
import { parseAdr, evaluateAdr, adrIsEnforced, type Adr } from "../adr.js";

const ADR_DIRS = ["docs/adr", "docs/decisions"];
const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php"];

function loadAdrs(cwd: string): { adr: Adr; file: string }[] {
  const out: { adr: Adr; file: string }[] = [];
  for (const dir of ADR_DIRS) {
    const abs = pathJoin(cwd, dir);
    if (!exists(abs)) continue;
    for (const f of walkSourceFiles(abs, { exts: [".md"] })) {
      const adr = parseAdr(read(f, "utf-8"));
      if (adr) out.push({ adr, file: rel(cwd, f) });
    }
  }
  return out;
}

export function cmdAdr(): boolean {
  const args = process.argv.slice(3);
  const sub = args[0] === "list" || args[0] === "check" ? args[0] : args[0] ? "help" : "check";
  const cwd = process.cwd();

  if (sub === "help") {
    console.log(`${c.bold}kit adr${c.reset} — enforce architecture decisions (ADR → gate)\n`);
    console.log("  kit adr list     ADRs + status + enforced/documented");
    console.log("  kit adr check    gate the repo on accepted ADRs' rules (default)");
    return true;
  }

  const adrs = loadAdrs(cwd);
  if (adrs.length === 0) {
    console.log(
      `${c.dim}No ADRs found in ${ADR_DIRS.join(" or ")}. Add one with a --- frontmatter (id/title/status) and a \`\`\`toml kit-enforce block.${c.reset}`,
    );
    return true;
  }

  if (sub === "list") {
    console.log(`${c.bold}ADRs${c.reset}`);
    for (const { adr, file } of adrs) {
      const state = adrIsEnforced(adr)
        ? `${c.green}enforced (${adr.rules.length} rule${adr.rules.length === 1 ? "" : "s"})${c.reset}`
        : adr.status === "accepted"
          ? `${c.yellow}documented, not enforced${c.reset}`
          : `${c.dim}${adr.status}${c.reset}`;
      console.log(`  ${adr.id}  ${adr.title}  [${state}]  ${c.dim}${file}${c.reset}`);
    }
    return true;
  }

  // check: gather repo code files once, evaluate every accepted ADR.
  const files = walkSourceFiles(cwd, { exts: CODE_EXTS, includeTests: true }).map((f) => ({
    path: rel(cwd, f),
    content: read(f, "utf-8"),
  }));

  let violationCount = 0;
  let gapCount = 0;
  let enforcedCount = 0;
  for (const { adr } of adrs) {
    if (!adrIsEnforced(adr)) continue;
    enforcedCount++;
    for (const v of evaluateAdr(adr, files)) {
      if (v.kind === "gap") {
        gapCount++;
        console.log(
          `${c.yellow}?${c.reset} ${v.file}:${v.line}  ${v.message}  ${c.dim}(${v.adrId})${c.reset}`,
        );
      } else {
        violationCount++;
        console.log(
          `${c.red}✗${c.reset} ${v.file}:${v.line}  ${v.message}  ${c.dim}(${v.adrId})${c.reset}`,
        );
      }
    }
  }

  if (enforcedCount === 0) {
    console.log(
      `${c.yellow}No accepted ADR carries an enforce block — nothing to gate (documented, not enforced).${c.reset}`,
    );
    return true;
  }
  if (violationCount === 0 && gapCount === 0) {
    console.log(`${c.green}✓ ${enforcedCount} enforced ADR(s) — no violations${c.reset}`);
    return true;
  }
  const parts: string[] = [];
  if (violationCount) parts.push(`${violationCount} violation(s)`);
  if (gapCount) parts.push(`${gapCount} unprovable rule(s) (unresolved imports)`);
  console.log(`\n${c.red}${parts.join(" + ")} across ${enforcedCount} enforced ADR(s).${c.reset}`);
  return false;
}
