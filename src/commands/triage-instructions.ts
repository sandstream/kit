// `kit triage instructions [path]`: read a repository's agent instruction files before an agent does.
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { c } from "../utils/colors.js";
import { hasFlag } from "../utils/flags.js";
import { scanInstructions, type InstructionScan } from "../instruction-scan.js";
import { sanitizeInstructionDisplay } from "../instruction-scan-text.js";

const NOT_READ =
  "README files are not read: install lines written for people (`curl … | sh`) would be false positives.";

function render(scan: InstructionScan): void {
  const read = scan.files.length - scan.unread.length;
  console.log(`${c.bold}kit triage instructions${c.reset}: ${scan.root}`);
  if (scan.files.length === 0 && scan.complete) {
    console.log(
      `  ${c.dim}no agent instruction files found (CLAUDE.md, AGENTS.md, SKILL.md, …)${c.reset}`,
    );
  }
  for (const f of scan.findings)
    console.log(`  ${c.red}✗${c.reset} ${f.file}:${f.line} [${f.rule}] ${f.excerpt}`);
  for (const u of scan.unread)
    console.log(
      `  ${c.yellow}!${c.reset} ${u}: not read (unavailable, not a regular file, over 1 MB, or finding limit reached)`,
    );
  for (const gap of scan.coverageGaps)
    console.log(`  ${c.yellow}!${c.reset} ${gap.path}: incomplete (${gap.reason})`);
  const verdict = !scan.complete
    ? `${c.red}incomplete scan (${scan.findings.length} finding(s))${c.reset}`
    : scan.findings.length
      ? `${c.red}${scan.findings.length} finding(s)${c.reset}`
      : `${c.green}no finding${c.reset}`;
  console.log(`\n  ${read} instruction file(s) read: ${verdict}.`);
  console.log(
    `  ${c.dim}A floor, not a guard: the first rules caught 3 of 20 attack lines written by a separate model that had not seen them; rules added since were written against 8 of those lines, so no blind figure exists for them. A finding is worth reading; no finding does not mean the files are safe. ${NOT_READ}${c.reset}`,
  );
}

function displayScan(scan: InstructionScan): InstructionScan {
  return {
    ...scan,
    root: sanitizeInstructionDisplay(scan.root),
    files: scan.files.map(sanitizeInstructionDisplay),
    unread: scan.unread.map(sanitizeInstructionDisplay),
    findings: scan.findings.map((finding) => ({
      ...finding,
      file: sanitizeInstructionDisplay(finding.file),
      excerpt: sanitizeInstructionDisplay(finding.excerpt),
    })),
    coverageGaps: scan.coverageGaps.map((gap) => ({
      ...gap,
      path: sanitizeInstructionDisplay(gap.path),
    })),
  };
}

/** Succeed only when coverage is complete and no finding exists, including an empty scope. */
export async function cmdTriageInstructions(args: string[]): Promise<boolean> {
  const json = hasFlag(args, "--json");
  const target = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
  let isDir: boolean;
  try {
    isDir = lstatSync(target).isDirectory();
  } catch {
    console.error(`kit triage instructions: ${sanitizeInstructionDisplay(target)} cannot be read`);
    return false;
  }
  const scan = scanInstructions(target, isDir);
  const display = displayScan(scan);
  if (json) console.log(JSON.stringify({ ...display, notRead: NOT_READ }, null, 2));
  else render(display);
  return scan.complete && scan.findings.length === 0;
}
