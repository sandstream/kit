/**
 * `kit check` row `instruction-file secrets`: a credential pasted into a file an agent reads as
 * instructions.
 *
 * Agent instruction files are committed on purpose and often published, and every agent session
 * reads them, so a key in one leaks twice. `kit agent-audit` reads agent configs and Claude's
 * command and agent dirs, not these; `kit triage instructions` reads them for injection, not keys.
 * Measured (kit-research `ai-built-app-holes-vs-kit`): `OPENAI_API_KEY=sk-proj-…` in `AGENTS.md`,
 * `CLAUDE.md`, `.cursorrules`, `.cursor/rules/a.mdc`, `GEMINI.md` or
 * `.github/copilot-instructions.md` produced no `kit check` row.
 *
 * The file set is kit's one instruction-file list (`discoverInstructionFiles`, `isInstructionFile`),
 * which covers Claude Code (`CLAUDE.md`, `CLAUDE.local.md`, `.claude/{rules,commands,agents}/**.md`,
 * `SKILL.md`), Codex (`AGENTS.md`, `AGENTS.override.md`), Cursor (`.cursorrules`,
 * `.cursor/rules/*.mdc`), Gemini CLI (`GEMINI.md`), GitHub Copilot
 * (`.github/copilot-instructions.md`) and Windsurf (`.windsurfrules`), in any letter case. The
 * patterns are kit's shared `findSecrets`. The row names the file and the pattern, never the value.
 */
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { discoverInstructionFiles, readInstructionFile } from "./instruction-scan-files.js";
import { findSecrets } from "./utils/redactSecrets.js";

const NAME = "instruction-file secrets";
const BASE = { category: "secrets", name: NAME } as const;
const SUGGESTION =
  "Remove the value from each listed file, rotate the credential (it was readable by every agent session and by anyone who can read the repository), and refer to it by name: keep the value in `kit secrets` or the environment.";

interface InstructionSecretHit {
  file: string;
  /** Pattern labels, sorted and unique. Never the matched value. */
  patterns: string[];
}

/** Pure: the pattern labels `findSecrets` matches in one file's text, without the values. */
function secretPatternsIn(text: string): string[] {
  return [...new Set(findSecrets(text).map((f) => f.label))].sort();
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Read every instruction file under `root` and report the files that hold a secret pattern. */
export function checkInstructionSecrets(root: string): SecurityCheckResult[] {
  const { files, coverageGaps } = discoverInstructionFiles(root);
  if (files.length === 0 && coverageGaps.length === 0) {
    return [{ ...BASE, status: "skip", detail: "no agent instruction files in the project" }];
  }
  const hits: InstructionSecretHit[] = [];
  const unread: string[] = [];
  for (const file of files) {
    const text = readInstructionFile(join(root, file));
    if (text === null) unread.push(file);
    else {
      const patterns = secretPatternsIn(text);
      if (patterns.length) hits.push({ file, patterns });
    }
  }
  const gaps = [...unread, ...coverageGaps.map((g) => `${g.path} (${g.reason})`)];
  return [resultFor(files.length - unread.length, hits, gaps)];
}

function resultFor(
  read: number,
  hits: InstructionSecretHit[],
  gaps: string[],
): SecurityCheckResult {
  const note = gaps.length ? `; scan incomplete, not read: ${gaps.join(", ")}` : "";
  if (hits.length) {
    const list = hits.map((h) => `${h.file} (${h.patterns.join(", ")})`).join("; ");
    return {
      ...BASE,
      status: "fail",
      severity: "critical",
      hasFindings: true,
      ...(gaps.length ? { scanIncomplete: true } : {}),
      detail: `secret pattern in ${plural(hits.length, "instruction file")} of ${read} read: ${list}${note}`,
      suggestion: SUGGESTION,
    };
  }
  if (gaps.length) {
    return {
      ...BASE,
      status: "warn",
      didNotRun: true,
      scanIncomplete: true,
      detail: `no secret pattern in ${plural(read, "instruction file")} read${note}`,
    };
  }
  return {
    ...BASE,
    status: "pass",
    detail: `no secret pattern in ${plural(read, "instruction file")} (Claude Code, Codex, Cursor, Gemini CLI, Copilot, Windsurf)`,
  };
}
