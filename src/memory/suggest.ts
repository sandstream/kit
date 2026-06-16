/**
 * kit memory suggest — opt-in, BYO-LLM memory review.
 *
 * Preserves kit's zero-LLM core: kit does NOT call a model. It deterministically
 * gathers the current project's recent activity + open action items and EMITS a
 * structured prompt to stdout, asking *your* model to propose new pal items /
 * shared-area entries worth recording. Pipe it: `kit memory suggest | <your-llm>`.
 * Proposals are reviewed by you and recorded via `kit memory pal add` /
 * `kit memory share`. No state is changed here.
 */
import type { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import { recentMessages } from "./db.js";
import { palList } from "./pal.js";
import { getCurrentProjectRoot } from "./project.js";

export interface SuggestInput {
  project: string;
  recentCount: number;
  openItems: number;
  /** The full prompt to feed to a model (the product of this command). */
  prompt: string;
}

export function buildSuggestPrompt(db: DatabaseSync, opts: { limit?: number } = {}): SuggestInput {
  const root = getCurrentProjectRoot();
  const project = basename(root);
  const recent = recentMessages(db, { projectPath: root, limit: opts.limit ?? 30 });
  const open = palList(db, { scope: project });

  const lines: string[] = [
    `You are reviewing the recent work log for the project "${project}".`,
    "",
    "RECENT MESSAGES (newest first):",
  ];
  if (recent.length === 0) {
    lines.push("  (none indexed for this project)");
  } else {
    for (const m of recent) {
      const who = m.role === "assistant" ? "assistant" : "user";
      const text = (m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
      if (text) lines.push(`  - ${who}: ${text}`);
    }
  }
  lines.push("");
  if (open.length > 0) {
    lines.push("ALREADY-OPEN ACTION ITEMS (do not duplicate these):");
    for (const p of open) lines.push(`  - ${p.id} ${p.title}`);
    lines.push("");
  }
  lines.push(
    "TASK: Propose what is worth RECORDING into long-term memory. Specifically:",
    "  1. New action items blocked on the user (things that must happen next).",
    "  2. Durable decisions / how-we-built-it / status / security notes worth keeping.",
    "Be concrete, skip anything already open above, and give each proposal a one-line title.",
    "",
    "The user will record accepted proposals via:",
    '  kit memory pal add "<title>"',
    '  kit memory share <area> <decisions|how-built|status|security> "<note>"',
  );

  return { project, recentCount: recent.length, openItems: open.length, prompt: lines.join("\n") };
}
