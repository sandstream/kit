/**
 * `.worktreeinclude` entries that copy `.env` files into every agent worktree.
 *
 * Claude Code and Orca read `.worktreeinclude` (gitignore syntax) to copy gitignored files into
 * each new worktree; `.env` is the documented typical entry. Each copy lives as long as its
 * worktree, outside the checkout `kit check` scans, so one plaintext secret becomes one file per
 * worktree (kit-research `orca-ade-vs-kit`). Read-only: names the entries, never opens the files.
 */
import { join } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { readInstructionFile } from "./instruction-scan-files.js";

/** Env files that hold placeholders by convention, not secrets. */
const PLACEHOLDERS = new Set([".env.example", ".env.sample", ".env.template"]);

/** True when the last path segment of a pattern is `.env`, `.env.<x>` or a `.env*` glob. Pure. */
function namesEnvFile(pattern: string): boolean {
  const last = pattern.replace(/\/+$/, "").split("/").pop() ?? "";
  return /^\.env($|[.*])/.test(last) && !PLACEHOLDERS.has(last);
}

/** The `.env` / `.env.*` entries in a `.worktreeinclude` body, as written. Pure. */
export function envEntries(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"))
    .filter(namesEnvFile);
}

/** One warn row naming each `.env` entry in `<root>/.worktreeinclude`; none when there is none. */
export function checkWorktreeInclude(root: string): SecurityCheckResult[] {
  const body = readInstructionFile(join(root, ".worktreeinclude"));
  if (body === null) return [];
  const entries = envEntries(body);
  if (entries.length === 0) return [];
  const named = entries.map((e) => JSON.stringify(e)).join(", ");
  return [
    {
      category: "secrets",
      name: ".worktreeinclude copies .env files",
      status: "warn",
      severity: "medium",
      detail: `${entries.length} entry(ies) copy env files into every agent worktree: ${named}`,
      suggestion:
        "keep secrets in the vault (kit secrets) and placeholders in .env.example; remove the .env entries from .worktreeinclude, or delete the copies in old worktrees",
    },
  ];
}
