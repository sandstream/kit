import { basename, join } from "node:path";
import {
  discoverInstructionFiles,
  readInstructionFile,
  type InstructionCoverageGap,
} from "./instruction-scan-files.js";
import { instructionFindings, type InstructionFinding } from "./instruction-scan-text.js";
import { companionPath, skillCompanions, skillFiles } from "./instruction-scan-companions.js";

export {
  findInstructionFiles,
  isInstructionFile,
  readInstructionFile,
} from "./instruction-scan-files.js";
export {
  scanInstructionText,
  type InstructionFinding,
  type InstructionRule,
} from "./instruction-scan-text.js";

const MAX_FINDINGS = 1000;

export interface InstructionScan {
  root: string;
  files: string[];
  /** The files in `files` read because a SKILL.md links or names them, or keeps them in references/. */
  companions: string[];
  unread: string[];
  findings: InstructionFinding[];
  coverageGaps: InstructionCoverageGap[];
  complete: boolean;
}

/** "N file(s) read", saying how many of them a SKILL.md pointed to, so the count says what was read. */
export function filesReadPhrase(scan: InstructionScan, noun = "file(s)"): string {
  const unread = new Set(scan.unread);
  const read = scan.files.length - scan.unread.length;
  const linked = scan.companions.filter((f) => !unread.has(f)).length;
  const via = linked > 0 ? ` (${linked} linked from a SKILL.md or in its references/)` : "";
  return `${read} ${noun} read${via}`;
}

/** Add each SKILL.md's linked and reference `.md` files to `files`; returns the ones added. */
function addCompanions(base: string, files: string[], gaps: InstructionCoverageGap[]): string[] {
  const known = new Set(files.map((f) => f.toLowerCase()));
  const added: string[] = [];
  for (const skill of skillFiles(files)) {
    const text = readInstructionFile(join(base, skill.rel));
    if (text === null) continue;
    const { files: found, dropped } = skillCompanions(join(base, skill.dir), text);
    for (const rel of found.map((f) => companionPath(skill.dir, f))) {
      if (known.has(rel.toLowerCase())) continue;
      known.add(rel.toLowerCase());
      added.push(rel);
    }
    for (const rel of dropped)
      gaps.push({ path: companionPath(skill.dir, rel), reason: "file-limit" });
  }
  files.push(...added);
  return added;
}

/** Scan the selected files and report incomplete discovery, reads, or analysis. */
export function scanInstructions(target: string, isDir: boolean): InstructionScan {
  const discovery = isDir
    ? discoverInstructionFiles(target)
    : { files: [basename(target)], coverageGaps: [] };
  const { files, coverageGaps } = discovery;
  const base = isDir ? target : join(target, "..");
  const companions = addCompanions(base, files, coverageGaps);
  const findings: InstructionFinding[] = [];
  const unread: string[] = [];
  let exhausted = false;
  for (const rel of files) {
    const text = exhausted ? null : readInstructionFile(join(base, rel));
    if (text === null) {
      unread.push(rel);
      continue;
    }
    for (const finding of instructionFindings(rel, text)) {
      if (findings.length >= MAX_FINDINGS) {
        coverageGaps.push({ path: rel, reason: "finding-limit" });
        exhausted = true;
        break;
      }
      findings.push(finding);
    }
  }
  return {
    root: target,
    files,
    companions,
    unread,
    findings,
    coverageGaps,
    complete: unread.length === 0 && coverageGaps.length === 0,
  };
}
