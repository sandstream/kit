import { basename, join } from "node:path";
import {
  discoverInstructionFiles,
  readInstructionFile,
  type InstructionCoverageGap,
} from "./instruction-scan-files.js";
import { instructionFindings, type InstructionFinding } from "./instruction-scan-text.js";

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
  unread: string[];
  findings: InstructionFinding[];
  coverageGaps: InstructionCoverageGap[];
  complete: boolean;
}

/** Scan the selected files and report incomplete discovery, reads, or analysis. */
export function scanInstructions(target: string, isDir: boolean): InstructionScan {
  const discovery = isDir
    ? discoverInstructionFiles(target)
    : { files: [basename(target)], coverageGaps: [] };
  const { files, coverageGaps } = discovery;
  const base = isDir ? target : join(target, "..");
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
    unread,
    findings,
    coverageGaps,
    complete: unread.length === 0 && coverageGaps.length === 0,
  };
}
