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
import { activeShared, formatAge, type SharedEntry } from "./shared.js";
import { decisionsForPaths, changedPaths } from "./clusters.js";
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
    // Deterministic PUSH (gap #3): if the working-tree changes fall into an area
    // that has active decisions, surface them — touch area X ⇒ see X's decisions,
    // not a query lottery. Bounded + fail-open (no clusters.json ⇒ nothing).
    const push = touchedDecisionsNotice();
    return (
      (stale ? `${stale}\n` : "") +
      `You have local conversation memory: ${s.messages} messages indexed. ` +
      "Before answering anything project-specific, run `kit memory search <terms>` " +
      `to retrieve what was actually said instead of reconstructing it.${pending}` +
      (push ? `\n${push}` : "")
    );
  } catch {
    return ""; // fail-open: never block a prompt
  }
}

/**
 * One-line notice of the active shared decisions for the area(s) whose files are
 * currently changed in the working tree — the deterministic push-surfacing
 * guardrail. "" when there's no cluster map, no changes, or no active decisions.
 * Bounded (≤2 areas, ≤2 decisions each) so it never floods the prompt. Fail-open.
 */
function touchedDecisionsNotice(root: string = getCurrentProjectRoot()): string {
  try {
    const groups = decisionsForPaths(root, changedPaths(root));
    if (!groups.length) return "";
    const parts = groups.slice(0, 2).map((g) => {
      const titles = g.decisions
        .slice(0, 2)
        .map((d) => `[${d.kind}] ${d.title}`)
        .join("; ");
      return `${g.area}: ${titles}`;
    });
    return `Active decisions for the area(s) you're touching — ${parts.join(" · ")}. (kit memory context for the full set.)`;
  } catch {
    return "";
  }
}

/**
 * The most recent ACTIVE durable shared decisions for a project, newest first.
 * "Durable" = the curated kinds worth re-surfacing on resume (decision /
 * convention / security / status); notes/how-built are excluded as lower-signal.
 * Superseded/reversed entries are filtered out (activeShared) — a resumed session
 * sees the current HEAD of the decision tree, not a graveyard. Fail-open:
 * activeShared returns [] on a missing/broken store. Deterministic, no model.
 */
export function recentDecisions(root: string, limit: number): SharedEntry[] {
  const DURABLE = new Set<SharedEntry["kind"]>(["decision", "convention", "security", "status"]);
  try {
    return activeShared(root)
      .filter((e) => DURABLE.has(e.kind))
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .slice(0, limit);
  } catch {
    return [];
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
    // Curated shared tier — re-inject the team's durable decisions on resume so
    // the agent regains the SETTLED context, not just the last few raw turns.
    // Fail-open (readShared swallows a missing/broken file → []).
    const decisions = recentDecisions(root, 3);
    const stale = staleKitNotice();
    if (recent.length === 0 && openItems.length === 0 && decisions.length === 0 && !stale)
      return "";

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
    if (decisions.length > 0) {
      lines.push("Curated team decisions (shared memory, active):");
      for (const d of decisions) {
        const age = formatAge(d.ts);
        lines.push(`  · [${d.kind}] ${d.area}: ${d.title}${age ? ` (${age})` : ""}`);
      }
    }
    if (openItems.length > 0) {
      const titles = openItems
        .slice(0, 3)
        .map((p) => `${p.id} ${p.title}`)
        .join("; ");
      lines.push(`Open action items blocked on you: ${titles}${openItems.length > 3 ? " …" : ""}.`);
    }
    if (recent.length > 0 || openItems.length > 0 || decisions.length > 0) {
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
    return spawnDetachedIndex();
  } catch {
    return false; // fail-open: never block a prompt
  }
}

/**
 * Launch a DETACHED `kit memory index` (fire-and-forget, stdio ignored, unref'd)
 * and return immediately — the caller never waits on the index. Shared by the
 * mid-session debounce and the SessionEnd hook. Returns true iff it launched.
 */
function spawnDetachedIndex(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const child = spawn(process.execPath, [resolve(entry), "memory", "index"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return true;
}

/**
 * SessionEnd indexing for the common path (no `push_on_end`): run the index in a
 * DETACHED child so the hook returns instantly. Indexing inline lets a periodic
 * all-harness sweep overrun Claude Code's shutdown window, which surfaces as
 * "SessionEnd hook … failed: Hook cancelled". The detached index still completes;
 * and the next SessionStart recovery re-indexes any tail it missed. Fail-open.
 *
 * NOTE: callers that push on end (ephemeral containers) must NOT use this — the
 * push has to observe this session's freshly-indexed rows, so it indexes inline.
 */
export function startDetachedSessionEndIndex(): boolean {
  try {
    return spawnDetachedIndex();
  } catch {
    return false; // fail-open: a session must never be blocked on exit
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
