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
import { openMemoryDb, getStats } from "./db.js";
import { indexClaudeTranscripts } from "./parser.js";
import { palList } from "./pal.js";

/** Reminder injected before every prompt. Empty string on any error (fail-open). */
export function userPromptSubmitReminder(): string {
  try {
    const db = openMemoryDb();
    const s = getStats(db);
    const open = s.pendingOpen > 0 ? palList(db).slice(0, 3) : [];
    db.close();
    let pending = "";
    if (s.pendingOpen > 0) {
      const titles = open.map((p) => `${p.id} ${p.title}`).join("; ");
      const more = s.pendingOpen > open.length ? " …" : "";
      pending = ` ${s.pendingOpen} open action item(s) blocked on you: ${titles}${more}.`;
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
