/**
 * `kit triage instructions`: read the files a coding agent takes as instructions (CLAUDE.md,
 * AGENTS.md, SKILL.md, Cursor rules, Copilot instructions) before the agent does, and report
 * what an attacker could have planted there, line by line.
 *
 * Measured before building (kit-research `instruction-file-scan-experiment`): on 43 real
 * instruction files from five repositories these rules gave no false positive, and they caught
 * 10 of 10 planted attacks (self-written).
 * On every markdown file of those repositories they were noisy: security docs and README
 * install lines (`curl https://mise.run | sh`) read like attacks. So this reads instruction
 * files only, and README files are left out on purpose.
 *
 * Then measured blind (2026-11-05): 20 attack lines written by a separate model that had not
 * seen these rules were caught 3 times; 20 benign lines written to sit close to the line gave
 * no false positive. High precision, low recall: a finding is worth reading, and no finding
 * does not mean the files are safe. The output says so.
 *
 * src/instruction-rules.ts was written after that, against 8 of the 20 attack lines: 11 of 20
 * are now caught, which is not a recall figure. A blind figure needs a set nobody has seen.
 *
 * Deterministic and explainable: each finding names its rule and line, and the output says
 * what was read, never that a repository is safe.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { findInjection, stripUnsafeChars } from "./memory/injection.js";
import { extraInstructionRules } from "./instruction-rules.js";
import { redactSecrets } from "./utils/redactSecrets.js";

export type InstructionRule =
  "secret-to-outbound" | "exec-after-download" | "conceal-from-user" | `injection:${string}`;

export interface InstructionFinding {
  file: string;
  line: number;
  rule: InstructionRule;
  /** The line, with hidden characters and secrets removed and length capped: safe to print. */
  excerpt: string;
}

/** File names read wherever they are. */
const INSTRUCTION_NAMES = new Set([
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "GEMINI.md",
  "SKILL.md",
  ".cursorrules",
  ".windsurfrules",
  "copilot-instructions.md",
]);
/** Dot-directories that hold instruction files; every other dot-directory is skipped. */
const INSTRUCTION_DOT_DIRS = new Set([".claude", ".cursor", ".github", ".codex", ".gemini"]);
const SKIPPED_DIRS = new Set(["node_modules", "dist", "build", "vendor", "target", "coverage"]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 20_000;
const MAX_FILES = 500;
const MAX_BYTES = 1_000_000;

const SECRET =
  /(~\/\.ssh|\bid_(rsa|ed25519|ecdsa)\b|(^|[\s`'"/])\.env\b|\.aws\/credentials|\.netrc\b|\.npmrc\b|\.pypirc\b|\bgh auth token\b|\bkeychain\b|\bprintenv\b|`env`|\$\(env\)|\bsecrets?\.json\b)/i;
const OUTBOUND =
  /(https?:\/\/(?!localhost\b|127\.0\.0\.1\b)[^\s)`'"]+|\bupload\b|\bPOST\b|\bsend\b|\bpaste\b|\bemail\b|@[a-z0-9-]+\.[a-z]{2,}|\bscp\b|\bcurl\b[^|\n]*\s-d\b|\binclude\b[^.\n]*\b(summary|issue|comment|message)\b)/i;
const EXEC_DOWNLOAD =
  /(base64\s+-d\s*\|\s*(ba)?sh|\b(curl|wget)\b[^\n|;&]*(&&|;)\s*(chmod\s+\+x|\/tmp\/|\.\/))/i;
const WHO = "(?:the\\s+)?(?:user|human|operator|owner|reviewer)s?";
const CONCEAL = new RegExp(
  `\\b(?:never|don'?t|do not|without)\\s+(?:tell(?:ing)?|inform(?:ing)?|notify(?:ing)?|alert(?:ing)?)\\s+${WHO}\\s+(?:about|that|of)\\b` +
    `|\\b(?:never|don'?t|do not|without)\\s+(?:mention(?:ing)?|reveal(?:ing)?|show(?:ing)?)\\s+(?:\\S+\\s+){0,4}to\\s+${WHO}\\b`,
  "i",
);

/** True for a file name (or `.cursor/rules/*.mdc` path) an agent reads as instructions. */
export function isInstructionFile(relPath: string): boolean {
  const parts = relPath.split(/[\\/]+/);
  const name = parts.at(-1) ?? "";
  if (INSTRUCTION_NAMES.has(name)) return true;
  return name.endsWith(".mdc") && parts.includes(".cursor") && parts.includes("rules");
}

function excerpt(line: string): string {
  const clean = redactSecrets(stripUnsafeChars(line))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
}

/** Findings in one instruction file's text. Pure. */
export function scanInstructionText(file: string, text: string): InstructionFinding[] {
  const out: InstructionFinding[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    const add = (rule: InstructionRule) =>
      out.push({ file, line: i + 1, rule, excerpt: excerpt(line) });
    for (const f of findInjection(line)) if (f.confidence === "high") add(`injection:${f.label}`);
    if (SECRET.test(line) && OUTBOUND.test(line)) add("secret-to-outbound");
    if (EXEC_DOWNLOAD.test(line)) add("exec-after-download");
    if (CONCEAL.test(line)) add("conceal-from-user");
    for (const rule of extraInstructionRules(line)) {
      if (!out.some((f) => f.line === i + 1 && f.rule === rule)) add(rule);
    }
  });
  return out;
}

/**
 * Instruction files under `root`, relative and sorted. A symlinked instruction file is listed
 * (agents follow it, so its target is read); symlinked directories are not walked.
 */
export function findInstructionFiles(root: string): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (abs: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES || found.length >= MAX_FILES) return;
      const path = join(abs, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if ((entry.isFile() || entry.isSymbolicLink()) && isInstructionFile(rel)) found.push(rel);
      else if (entry.isDirectory() && depth < MAX_DEPTH && !SKIPPED_DIRS.has(entry.name)) {
        if (entry.name.startsWith(".") && !INSTRUCTION_DOT_DIRS.has(entry.name)) continue;
        walk(path, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * A file's text through one descriptor, checked with fstat on that descriptor; null when it
 * is not a regular file, cannot be opened (a dangling link), or is too large to be an
 * instruction file. A symlink is followed, as the agent would follow it.
 */
export function readInstructionFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export interface InstructionScan {
  root: string;
  files: string[];
  unread: string[];
  findings: InstructionFinding[];
}

/** Scan a directory, or one file given directly. */
export function scanInstructions(target: string, isDir: boolean): InstructionScan {
  const files = isDir ? findInstructionFiles(target) : [basename(target)];
  const base = isDir ? target : join(target, "..");
  const findings: InstructionFinding[] = [];
  const unread: string[] = [];
  for (const rel of files) {
    const text = readInstructionFile(join(base, rel));
    if (text === null) unread.push(rel);
    else findings.push(...scanInstructionText(rel, text));
  }
  return { root: target, files, unread, findings };
}
