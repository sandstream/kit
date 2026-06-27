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
import { basename, join, resolve } from "node:path";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { openMemoryDb, getStats, recentMessages, getMemoryDir, ensureMemoryDir } from "./db.js";
import { indexClaudeTranscripts, indexAllHarnesses } from "./parser.js";
import { palList } from "./pal.js";
import { getCurrentProjectRoot } from "./project.js";
import { readCachedUpdateSync, getKitVersionSync } from "../update-check.js";

/**
 * A one-line, actionable stale-kit notice for Claude Code context, or "". Reads
 * the update cache only (no network) so it is safe on the every-prompt hook. The
 * point: surface "kit needs updating" where the user actually works (Claude Code),
 * not only in a terminal banner they rarely see.
 */
function staleKitNotice(): string {
  try {
    const u = readCachedUpdateSync(getKitVersionSync());
    if (!u) return "";
    return `kit is out of date: ${u.current} → ${u.latest}. Update with \`kit upgrade --self\` (triages the package first, installs only on a triage PASS).`;
  } catch {
    return ""; // fail-open
  }
}

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
    const stale = staleKitNotice();
    return (
      (stale ? `${stale}\n` : "") +
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
    const stale = staleKitNotice();
    if (recent.length === 0 && openItems.length === 0 && !stale) return "";

    const lines: string[] = [];
    if (stale) lines.push(stale);
    if (recent.length > 0 || openItems.length > 0) {
      lines.push(`Picking up in ${basename(root)} — recent memory (newest first):`);
    }
    for (const m of recent) {
      const who = m.role === "assistant" ? "assistant" : "you";
      const text = (m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (text) lines.push(`  · ${who}: ${text}`);
    }
    if (openItems.length > 0) {
      const titles = openItems
        .slice(0, 3)
        .map((p) => `${p.id} ${p.title}`)
        .join("; ");
      lines.push(`Open action items blocked on you: ${titles}${openItems.length > 3 ? " …" : ""}.`);
    }
    if (recent.length > 0 || openItems.length > 0) {
      lines.push("Run `kit memory search <terms>` to pull more of what was actually said.");
    }
    return lines.join("\n");
  } catch {
    return ""; // fail-open: never block a session start
  }
}

/**
 * The just-ended session is Claude Code, so we always index that (cheap +
 * incremental). The OTHER harnesses (codex/cursor/gemini/cline/amazon-q/opencode…)
 * have no kit hook, so they'd only get indexed on a manual `kit memory index`.
 * To pick them up automatically WITHOUT walking six extra dirs on every single
 * session end, we sweep all harnesses at most once per interval, debounced by a
 * marker file's mtime. Keeps SessionEnd cheap on the common path.
 */
const HARNESS_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

function harnessSweepMarker(): string {
  return join(getMemoryDir(), ".harness-sweep");
}

/** True if the periodic all-harness sweep is due (marker missing or older than the interval). */
export function dueForHarnessSweep(now: number = Date.now()): boolean {
  try {
    const marker = harnessSweepMarker();
    if (!existsSync(marker)) return true;
    return now - statSync(marker).mtimeMs >= HARNESS_SWEEP_INTERVAL_MS;
  } catch {
    return false; // can't tell → don't add the sweep's latency
  }
}

function markHarnessSwept(): void {
  try {
    ensureMemoryDir();
    writeFileSync(harnessSweepMarker(), new Date().toISOString(), { mode: 0o600 });
  } catch {
    /* best-effort: a missed marker just means we sweep again next time */
  }
}

/**
 * Mid-session recall freshness. SessionEnd indexes the session when it ends, but
 * a long session — or one whose (ephemeral / remote) container is reclaimed before
 * a clean SessionEnd ever fires — would leave its recent turns unsearchable. So on
 * every prompt we cheaply check a debounce marker and, at most once per interval,
 * kick a DETACHED `kit memory index` so recall stays fresh WITHOUT adding latency
 * to the prompt (a full index parse is seconds; we never block on it). Shorter
 * interval than the harness sweep because it tracks the live session.
 */
const MID_SESSION_INDEX_INTERVAL_MS = 10 * 60 * 1000; // 10 min

function midSessionIndexMarker(): string {
  return join(getMemoryDir(), ".mid-session-index");
}

/** True if a mid-session index is due (marker missing or older than the interval). */
export function dueForMidSessionIndex(now: number = Date.now()): boolean {
  try {
    const marker = midSessionIndexMarker();
    if (!existsSync(marker)) return true;
    return now - statSync(marker).mtimeMs >= MID_SESSION_INDEX_INTERVAL_MS;
  } catch {
    return false; // can't tell → don't add work
  }
}

function markMidSessionIndexed(): void {
  try {
    ensureMemoryDir();
    writeFileSync(midSessionIndexMarker(), new Date().toISOString(), { mode: 0o600 });
  } catch {
    /* best-effort: a missed marker just means we index again next time */
  }
}

/**
 * If due, stamp the debounce marker and launch a DETACHED `kit memory index`
 * (fire-and-forget, stdio ignored, unref'd) so the live session's recent turns
 * become searchable without waiting for SessionEnd. Stamps BEFORE spawning so
 * concurrent prompts don't stampede. Fail-open: any error is swallowed so a
 * prompt is never blocked. Returns true iff it launched an index.
 */
export function maybeStartMidSessionIndex(): boolean {
  try {
    if (!dueForMidSessionIndex()) return false;
    markMidSessionIndexed(); // stamp first → debounce holds even if the spawn races
    const entry = process.argv[1];
    if (!entry) return false;
    const child = spawn(process.execPath, [resolve(entry), "memory", "index"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return true;
  } catch {
    return false; // fail-open: never block a prompt
  }
}

/** Index the just-ended session. Returns count of newly indexed messages (fail-open). */
export function runSessionEndIndex(): { messages: number } {
  try {
    const db = openMemoryDb();
    let messages: number;
    if (dueForHarnessSweep()) {
      // includes claude-code, so no separate Claude pass needed
      const all = indexAllHarnesses(db);
      messages = Object.values(all).reduce((sum, r) => sum + r.messages, 0);
      markHarnessSwept();
    } else {
      messages = indexClaudeTranscripts(db).messages;
    }
    db.close();
    return { messages };
  } catch {
    return { messages: 0 }; // fail-open
  }
}
