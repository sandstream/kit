import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Teach the coding agent to use kit.
 *
 * `kit setup` only writes `.kit.toml` — it does not tell Claude Code / Codex /
 * Cursor / Cline to actually *run* kit. This module injects a small, managed
 * instruction block into the agent's rules file so the agent runs `kit check`,
 * triages dependencies before install, and resolves secrets via the vault.
 *
 * Safety: this only writes plain text the agent reads — it never registers an
 * executable hook (that's a separate, more invasive opt-in). The block is
 * delimited by BEGIN/END markers and is idempotent: re-running updates the
 * block in place and never touches anything outside the markers.
 */

export const KIT_BLOCK_BEGIN = "<!-- BEGIN kit (managed block — edit outside the markers, not inside) -->";
export const KIT_BLOCK_END = "<!-- END kit -->";

/** The canonical "use kit" instruction. Kept short on purpose — agents read it
 *  every turn, so it states the rules, not the rationale. */
export const KIT_INSTRUCTION = `## kit

This project uses [kit](https://github.com/sandstream/kit) to manage tools, secrets, and environment setup. As the agent working here:

- Run \`kit check\` before starting; if it reports \`fail\`, run \`kit fix\` then re-check.
- Before installing ANY dependency, run \`kit triage npm|pip|docker|repo <target>\` and only install if it passes.
- Never write secrets to \`.env*\` in plaintext — resolve them with \`kit secrets\` (vault-backed).
- After a batch of edits, run \`kit check --category security\`; halt and surface findings on \`fail\`.
- Destructive secret ops require \`kit auth elevate\` first.`;

export interface AgentTarget {
  /** Agent/tool name for display. */
  agent: string;
  /** Rules file, relative to project root. */
  file: string;
}

/** Rules file per agent. CLAUDE.md / AGENTS.md are the common cross-tool ones;
 *  Cursor and Cline read their own dotfiles. */
export const AGENT_TARGETS: AgentTarget[] = [
  { agent: "Claude Code", file: "CLAUDE.md" },
  { agent: "Codex", file: "AGENTS.md" },
  { agent: "Cursor", file: ".cursorrules" },
  { agent: "Cline", file: ".clinerules" },
];

/**
 * Which agents look present in this project. Presence = the rules file already
 * exists OR a tool-specific marker dir/file is there. When nothing matches we
 * fall back to the two portable defaults (CLAUDE.md + AGENTS.md) so a fresh
 * project still gets wired.
 */
export function detectAgentTargets(cwd: string = process.cwd()): AgentTarget[] {
  const present = AGENT_TARGETS.filter((t) => {
    if (existsSync(resolve(cwd, t.file))) return true;
    switch (t.agent) {
      case "Claude Code":
        return existsSync(resolve(cwd, ".claude"));
      case "Codex":
        return existsSync(resolve(cwd, ".codex"));
      case "Cursor":
        return existsSync(resolve(cwd, ".cursor"));
      default:
        return false;
    }
  });
  if (present.length > 0) return present;
  return AGENT_TARGETS.filter((t) => t.file === "CLAUDE.md" || t.file === "AGENTS.md");
}

/**
 * Insert or update the managed kit block in `content`. Pure string transform —
 * no I/O — so it's trivially testable.
 *
 * - No existing block → append (with a blank-line separator if the file is non-empty).
 * - Existing block → replace just the marker-delimited region, preserving everything else.
 */
export function upsertKitBlock(content: string): { next: string; action: "created" | "updated" | "unchanged" } {
  const block = `${KIT_BLOCK_BEGIN}\n\n${KIT_INSTRUCTION}\n\n${KIT_BLOCK_END}`;
  const begin = content.indexOf(KIT_BLOCK_BEGIN);
  const end = content.indexOf(KIT_BLOCK_END);

  if (begin !== -1 && end !== -1 && end > begin) {
    const before = content.slice(0, begin);
    const after = content.slice(end + KIT_BLOCK_END.length);
    const next = before + block + after;
    return { next, action: next === content ? "unchanged" : "updated" };
  }

  const sep = content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return { next: content + sep + block + "\n", action: "created" };
}

export interface AgentConfigResult {
  agent: string;
  file: string;
  action: "created" | "updated" | "unchanged" | "failed";
  detail: string;
}

/**
 * Write the managed kit block into each detected agent's rules file.
 * Read-only mode refuses + audits before any write.
 */
export async function writeAgentConfig(
  cwd: string = process.cwd(),
  targets?: AgentTarget[],
): Promise<AgentConfigResult[]> {
  const { isReadOnlyMode, refuseWrite } = await import("./read-only-mode.js");
  if (isReadOnlyMode()) {
    const refusal = await refuseWrite("write-agent-config", {});
    return [{ agent: "all", file: "-", action: "failed", detail: refusal.reason }];
  }

  const chosen = targets ?? detectAgentTargets(cwd);
  const results: AgentConfigResult[] = [];

  for (const t of chosen) {
    const path = resolve(cwd, t.file);
    let existing = "";
    try {
      existing = await readFile(path, "utf-8");
    } catch {
      existing = ""; // file absent — will be created
    }
    try {
      const { next, action } = upsertKitBlock(existing);
      if (action === "unchanged") {
        results.push({ agent: t.agent, file: t.file, action, detail: "kit block already current" });
        continue;
      }
      await writeFile(path, next, "utf-8");
      results.push({
        agent: t.agent,
        file: t.file,
        action,
        detail: action === "created" ? `wrote kit block to ${t.file}` : `updated kit block in ${t.file}`,
      });
    } catch (err) {
      results.push({
        agent: t.agent,
        file: t.file,
        action: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
