/**
 * Env-write-gate — make "never write secrets to .env* in plaintext" true even in
 * agent auto-mode.
 *
 * The rules-file line only ADVISES; an agent in auto/bypass mode can Write/Edit a
 * real credential straight into `.env` and it sits there in plaintext (and one
 * `git add -A` later, in history). kit's plaintext scan catches it AFTER the fact;
 * this PreToolUse hook is the *prevention* layer: it inspects the content of any
 * Write/Edit aimed at an env file BEFORE it lands, and blocks when the content
 * matches kit's secret patterns (the same detector `kit check` scans with, so the
 * two layers can never disagree about what a secret looks like).
 *
 * Deliberately narrow to keep false blocks near zero:
 *   - Only fires on env-shaped filenames (.env, .env.local, .envrc, …) — never on
 *     source files.
 *   - Template/example files (.env.example/.sample/.template/.dist) are exempt —
 *     placeholders belong there.
 *   - Only blocks when the written TEXT actually contains a secret-pattern match
 *     (findSecrets) — writing `API_KEY=` or `API_KEY=changeme` stays allowed.
 *
 * Pure decision logic (unit-tested); the CLI wrapper (`kit gate-env`) does stdin
 * parsing + the exit-2 PreToolUse deny, mirroring `kit gate-bash`.
 */
import { basename } from "node:path";
import { findSecrets } from "./utils/redactSecrets.js";

/** Env-shaped filenames the gate watches. `.env`, `.env.<anything>`, `.envrc`. */
const ENV_FILE_RE = /^\.env(\..+)?$|^\.envrc$/i;

/** Template/example variants where placeholder values are the point — exempt. */
const TEMPLATE_RE = /\.(example|sample|template|dist|defaults)$/i;

/** True when `filePath` names a real (non-template) env file. */
export function isEnvFile(filePath: string): boolean {
  const name = basename(filePath);
  return ENV_FILE_RE.test(name) && !TEMPLATE_RE.test(name);
}

export interface EnvWriteGateVerdict {
  block: boolean;
  reason?: string;
}

/**
 * Decide whether a Write/Edit of `text` into `filePath` should be blocked.
 * Blocks ONLY a secret-pattern hit inside a real env file — everything else passes.
 * Pure + deterministic.
 */
export function decideEnvWriteGate(filePath: string, text: string): EnvWriteGateVerdict {
  if (!filePath || !isEnvFile(filePath)) return { block: false };
  if (!text) return { block: false };
  const findings = findSecrets(text);
  if (findings.length === 0) return { block: false };
  const labels = [...new Set(findings.map((f) => f.label))].slice(0, 3).join(", ");
  return {
    block: true,
    reason: `plaintext secret (${labels}) written to ${basename(filePath)}`,
  };
}

/**
 * Extract the file path + written text from a PreToolUse hook payload for the
 * file-writing tools. Claude Code shapes:
 *   Write        → tool_input.file_path + tool_input.content
 *   Edit         → tool_input.file_path + tool_input.new_string
 *   NotebookEdit → tool_input.notebook_path + tool_input.new_source
 * Returns null when the payload isn't a file write (→ allow). Pure.
 */
export function extractWriteFromHookPayload(
  payload: unknown,
): { filePath: string; text: string } | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  const filePath =
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.notebook_path === "string" && input.notebook_path) ||
    "";
  if (!filePath) return null;
  const parts: string[] = [];
  for (const key of ["content", "new_string", "new_source"]) {
    if (typeof input[key] === "string") parts.push(input[key] as string);
  }
  // MultiEdit-style payloads: edits[] of { new_string }.
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      const ns = (e as Record<string, unknown>)?.new_string;
      if (typeof ns === "string") parts.push(ns);
    }
  }
  if (parts.length === 0) return null;
  return { filePath, text: parts.join("\n") };
}
