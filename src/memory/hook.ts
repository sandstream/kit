/**
 * kit memory — Claude Code hook entry points (the "whole system is two hooks").
 *
 *  - UserPromptSubmit → a short reminder that searchable memory exists. The agent
 *    pulls on demand (`kit memory search`) instead of pre-loading everything.
 *  - SessionEnd → index the just-ended session into the store (incremental sync).
 *
 * Both are FAIL-OPEN: any error yields an empty/no-op result so a hook can never
 * block a prompt or break a session. Deterministic, zero model calls.
 */
import { basename } from "node:path";
import { openMemoryDb, getStats, recentMessages } from "./db.js";
import { indexClaudeTranscripts } from "./parser.js";
import { palList } from "./pal.js";
import { getCurrentProjectRoot } from "./project.js";

/** Reminder injected before every prompt. Empty string on any error (fail-open). */
export function userPromptSubmitReminder(): string {
  try {
    const db = openMemoryDb();
    const s = getStats(db);
    // Only surface THIS project's open items (plus globally-scoped) — no cross-project noise.
    const openItems = palList(db, { scope: basename(getCurrentProjectRoot()) });
    db.close();
    let pending = "";
    if (openItems.length > 0) {
      const shown = openItems.slice(0, 3);
      const titles = shown.map((p) => `${p.id} ${p.title}`).join("; ");
      const more = openItems.length > shown.length ? " …" : "";
      pending = ` ${openItems.length} open action item(s) blocked on you: ${titles}${more}.`;
    }
    return (
      `You have local conversation memory: ${s.messages} messages indexed. ` +
      "Before answering anything project-specific, run `kit memory search <terms>` " +
      `to retrieve what was actually said instead of reconstructing it.${pending}`
    );
  } catch {
    return ""; // fail-open: never block a prompt
  }
}

/**
 * SessionStart recovery — re-inject "where you left off" for THIS project after a
 * resume/compact, so the agent regains continuity instead of starting blank. Pulls
 * the most recent messages + open action items from the store. FAIL-OPEN and
 * deterministic: empty string on any error or when there's nothing to recover.
 */
export function sessionStartRecovery(opts: { limit?: number } = {}): string {
  try {
    const db = openMemoryDb();
    const root = getCurrentProjectRoot();
    const recent = recentMessages(db, { projectPath: root, limit: opts.limit ?? 6 });
    const openItems = palList(db, { scope: basename(root) });
    db.close();
    if (recent.length === 0 && openItems.length === 0) return "";

    const lines: string[] = [`Picking up in ${basename(root)} — recent memory (newest first):`];
    for (const m of recent) {
      const who = m.role === "assistant" ? "assistant" : "you";
      const text = (m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (text) lines.push(`  · ${who}: ${text}`);
    }
    if (openItems.length > 0) {
      const titles = openItems.slice(0, 3).map((p) => `${p.id} ${p.title}`).join("; ");
      lines.push(
        `Open action items blocked on you: ${titles}${openItems.length > 3 ? " …" : ""}.`,
      );
    }
    lines.push("Run `kit memory search <terms>` to pull more of what was actually said.");
    return lines.join("\n");
  } catch {
    return ""; // fail-open: never block a session start
  }
}

/** Index the just-ended session. Returns count of newly indexed messages (fail-open). */
export function runSessionEndIndex(): { messages: number } {
  try {
    const db = openMemoryDb();
    const res = indexClaudeTranscripts(db);
    db.close();
    return { messages: res.messages };
  } catch {
    return { messages: 0 }; // fail-open
  }
}
