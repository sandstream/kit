/**
 * The script files a Claude `settings.json` hook runs.
 *
 * The 2026 npm worms (SAP CAP, TanStack, AntV, ChainDrop) persisted with a `SessionStart` hook in
 * `.claude/settings.json` whose command was `node .claude/setup.mjs`: the command string itself
 * has no malware shape, the payload is in the file. `auditSettingsCommands` read only the string,
 * so the shape passed (kit-research `supply-chain-2026-fundamentals-vs-kit`).
 *
 * This reads each project-relative script a hook command names and runs the same malware
 * patterns on its content. A `SessionStart` hook that runs a project file is also reported as a
 * warning even when the file looks clean: it executes on every agent start, from a file any
 * dependency's install script can write.
 */
import { isAbsolute, resolve } from "node:path";
import type { SecurityCheckResult } from "./check-security.js";
import { auditHookBody } from "./agent-audit.js";
import { readInstructionFile } from "./instruction-scan.js";

const SCRIPT = /\.(m?js|cjs|ts|mts|sh|bash|zsh|py|rb|ps1)$/i;

/** `[event, command]` for every hook command in a settings.json text. */
export function hookCommands(json: string): Array<[string, string]> {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return [];
  }
  const hooks = (obj as { hooks?: unknown })?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: Array<[string, string]> = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      const hs = (g as { hooks?: unknown })?.hooks;
      if (!Array.isArray(hs)) continue;
      for (const h of hs) {
        const cmd = (h as { command?: unknown })?.command;
        if (typeof cmd === "string" && cmd) out.push([event, cmd]);
      }
    }
  }
  return out;
}

/** Project-relative script paths a command names (`$CLAUDE_PROJECT_DIR/` counts as relative). */
export function scriptPaths(command: string): string[] {
  return command
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, "").replace(/^\$\{?CLAUDE_PROJECT_DIR\}?[\\/]/, ""))
    .filter((w) => w && !w.startsWith("-") && !isAbsolute(w) && SCRIPT.test(w));
}

/** Rows for the scripts the hooks in `json` (found at `shown`) run, resolved under `root`. */
export function hookScriptRows(json: string, root: string, shown: string): SecurityCheckResult[] {
  const rows: SecurityCheckResult[] = [];
  for (const [event, command] of hookCommands(json)) {
    for (const rel of scriptPaths(command)) {
      // One descriptor for the size check and the read, so the file cannot be swapped between them.
      const body = readInstructionFile(resolve(root, rel));
      if (body === null) continue;
      const why = auditHookBody(body);
      if (why.length > 0) {
        rows.push({
          category: "exposure",
          name: `malware-shaped hook script ${rel} (${shown} hooks.${event})`,
          status: "fail",
          severity: "high",
          detail: `${rel}, run by a ${event} hook in ${shown}, ${why.join("; ")}`,
          suggestion: `remove the hook from ${shown} and inspect ${rel}; it runs automatically`,
        });
      } else if (event === "SessionStart") {
        rows.push({
          category: "exposure",
          name: `SessionStart hook runs a project file (${rel})`,
          status: "warn",
          severity: "low",
          detail: `${shown} runs ${rel} on every agent start; no known malware shape in it, but any install script can rewrite it`,
          suggestion: `confirm ${rel} is yours and reviewed, or run a command instead of a repo file`,
        });
      }
    }
  }
  return rows;
}
