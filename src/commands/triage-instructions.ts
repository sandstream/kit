// `kit triage instructions [path]`: read a repository's agent instruction files before an agent does.
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { scanInstructions, type InstructionScan } from "../instruction-scan.js";

const NOT_READ =
  "README files are not read: install lines written for people (`curl … | sh`) would be false positives.";

function render(scan: InstructionScan): void {
  const read = scan.files.length - scan.unread.length;
  console.log(`${c.bold}kit triage instructions${c.reset} — ${scan.root}`);
  if (scan.files.length === 0) {
    console.log(
      `  ${c.dim}no agent instruction files found (CLAUDE.md, AGENTS.md, SKILL.md, …)${c.reset}`,
    );
    return;
  }
  for (const f of scan.findings)
    console.log(`  ${c.red}✗${c.reset} ${f.file}:${f.line} [${f.rule}] ${f.excerpt}`);
  for (const u of scan.unread)
    console.log(
      `  ${c.yellow}!${c.reset} ${u}: not read (not a regular file, unreadable, or over 1 MB)`,
    );
  const verdict = scan.findings.length
    ? `${c.red}${scan.findings.length} finding(s)${c.reset}`
    : `${c.green}no finding${c.reset}`;
  console.log(`\n  ${read} instruction file(s) read: ${verdict}.`);
  console.log(
    `  ${c.dim}A floor, not a guard: the first rules caught 3 of 20 attack lines written by a separate model that had not seen them; rules added since were written against 8 of those lines, so no blind figure exists for them. A finding is worth reading; no finding does not mean the files are safe. ${NOT_READ}${c.reset}`,
  );
}

/** Exit status: false on any finding or unreadable file, true otherwise (including no files). */
export async function cmdTriageInstructions(args: string[]): Promise<boolean> {
  const json = hasFlag(args, "--json");
  const target = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
  if (!existsSync(target)) {
    console.error(`kit triage instructions: ${target} does not exist`);
    return false;
  }
  const scan = scanInstructions(target, lstatSync(target).isDirectory());
  if (json) console.log(JSON.stringify({ ...scan, notRead: NOT_READ }, null, 2));
  else render(scan);
  return scan.findings.length === 0 && scan.unread.length === 0;
}
