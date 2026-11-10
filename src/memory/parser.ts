/**
 * Claude Code transcript parser for kit memory.
 *
 * Reads raw session transcripts from ~/.claude/projects/<project>/<session>.jsonl
 * and indexes them into the memory store. RAW + idempotent: one row per message
 * (deduped by uuid), without summaries. Reindex retains existing messages and
 * adds native tool identifiers and response evidence. Sessions retain their harness tag.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import { indexCodexSessions } from "./codex.js";
import { indexGeminiSessions } from "./gemini.js";
import { indexContinueSessions } from "./continue.js";
import { indexCursorSessions } from "./cursor.js";
import { indexAmazonQSessions } from "./amazonq.js";
import { indexKiroSessions } from "./kiro.js";
import { indexDroidSessions } from "./droid.js";
import { indexAiderSessions } from "./aider.js";
import { indexAntigravitySessions } from "./antigravity.js";
import { extractText, type Content } from "./content.js";
import { captureClaudeTools } from "./claude-tools.js";
import {
  captureTranscript,
  transcriptRecord,
  TOOL_CAPTURE_VERSION,
  type TranscriptTools,
} from "./transcript-tools.js";

// Re-exported: callers and tests import extractText from the parser.
export { extractText };
import { indexClineSessions } from "./cline.js";
import { indexOpenCodeSessions } from "./opencode.js";

export interface IndexResult {
  files: number;
  sessions: number;
  messages: number;
  toolUses: number;
  /** Files skipped because they were unchanged since the last index (incremental). */
  filesSkipped: number;
}

export function getClaudeProjectsDir(): string {
  const base = process.env.KIT_CLAUDE_DIR ?? join(homedir(), ".claude");
  return join(base, "projects");
}

/** Extract tool_use blocks from a message's content. */
export function extractToolUses(content: Content): { name: string; input: string }[] {
  if (!Array.isArray(content)) return [];
  const out: { name: string; input: string }[] = [];
  for (const b of content) {
    if (b?.type === "tool_use") {
      out.push({
        name: b.name ?? "unknown",
        input: b.input === undefined ? "" : JSON.stringify(b.input),
      });
    }
  }
  return out;
}

interface TranscriptRecord {
  type?: string;
  uuid?: string;
  sessionId?: string;
  parentUuid?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: Content;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function indexFile(
  db: DatabaseSync,
  filepath: string,
  project: string,
): { messages: number; toolUses: number; retry: boolean } | undefined {
  const sessionId = basename(filepath, ".jsonl");
  let raw: string;
  try {
    raw = readFileSync(filepath, "utf8");
  } catch (e) {
    // A read failure (permissions, I/O, a transcript rotated mid-index) is NOT the
    // same as an empty file — say so rather than silently reporting 0 indexed.
    console.error(`kit: could not read transcript ${filepath}: ${(e as Error).message}`);
    return;
  }

  return captureTranscript(db, (tools) => indexRecords(db, raw, sessionId, project, tools));
}

function indexRecords(
  db: DatabaseSync,
  raw: string,
  sessionId: string,
  project: string,
  tools: TranscriptTools,
): { messages: number; toolUses: number } {
  // Ensure the session row exists before inserting messages so per-message
  // counters resolve against a real row.
  upsertSession(db, { sessionId, harness: "claude-code", project });

  let messages = 0;
  let malformed = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let isSidechain = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rec = transcriptRecord(trimmed, tools) as TranscriptRecord | undefined;
    if (!rec) {
      malformed++;
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    if (!rec.uuid) {
      tools.complete = false;
      continue;
    }
    if (rec.isSidechain) isSidechain = true;

    const ts = rec.timestamp;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    if (storeClaudeRecord(db, rec as TranscriptRecord & { uuid: string }, sessionId, tools))
      messages++;
  }

  // Final upsert records the session's time bounds + sidechain flag.
  upsertSession(db, {
    sessionId,
    harness: "claude-code",
    project,
    firstMessageAt: firstTs,
    lastMessageAt: lastTs,
    isAgentSidechain: isSidechain,
  });

  // Parsed nothing usable AND hit parse failures → the file looks corrupt / a new
  // format. Surface it instead of reporting a clean 0 that reads as "up to date".
  if (messages === 0 && malformed > 0) {
    console.error(
      `kit: indexed 0 messages but ${malformed} line(s) failed to parse; transcript may be corrupt or an unrecognised format`,
    );
  }

  return { messages, toolUses: tools.added };
}

function storeClaudeRecord(
  db: DatabaseSync,
  rec: TranscriptRecord & { uuid: string },
  sessionId: string,
  tools: TranscriptTools,
): boolean {
  const msg = rec.message;
  const ts = rec.timestamp;
  const added = insertMessage(db, {
    uuid: rec.uuid,
    sessionId: rec.sessionId ?? sessionId,
    parentUuid: rec.parentUuid,
    type: rec.type!,
    role: msg?.role,
    content: extractText(msg?.content),
    model: msg?.model,
    inputTokens: msg?.usage?.input_tokens,
    outputTokens: msg?.usage?.output_tokens,
    cacheReadTokens: msg?.usage?.cache_read_input_tokens,
    cacheCreationTokens: msg?.usage?.cache_creation_input_tokens,
    timestamp: ts,
    cwd: rec.cwd,
    gitBranch: rec.gitBranch,
    version: rec.version,
  });

  const origin = rec.sessionId ?? sessionId;
  tools.message(rec.uuid, origin);
  captureClaudeTools(tools, msg?.content, {
    uuid: rec.uuid,
    sessionId: origin,
    timestamp: ts,
    added,
  });
  return added;
}

/** Walk ~/.claude/projects and index every transcript. Idempotent. */
export function indexClaudeTranscripts(db: DatabaseSync): IndexResult {
  const projectsDir = getClaudeProjectsDir();
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  if (!existsSync(projectsDir)) return result;

  for (const projectName of readdirSync(projectsDir).sort()) {
    const projectPath = join(projectsDir, projectName);
    let isDir: boolean;
    try {
      isDir = statSync(projectPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    for (const entry of readdirSync(projectPath).sort()) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = join(projectPath, entry);
      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      // Skip files unchanged since the last index (incremental — avoids re-reading
      // every transcript each run; the per-message uuid dedup still backstops it).
      const mtimeMs = Math.floor(st.mtimeMs);
      if (isFileIndexed(db, filePath, mtimeMs, st.size, TOOL_CAPTURE_VERSION)) {
        result.filesSkipped++;
        continue;
      }
      const counts = indexFile(db, filePath, projectName);
      if (!counts) continue;
      if (!counts.retry) markFileIndexed(db, filePath, mtimeMs, st.size, TOOL_CAPTURE_VERSION);
      result.files++;
      result.sessions++;
      result.messages += counts.messages;
      result.toolUses += counts.toolUses;
    }
  }
  return result;
}

/** Per-harness index results, keyed by harness name. */
export type HarnessResults = Record<string, IndexResult>;

/**
 * Index every supported harness's transcripts into the store. Returns per-harness
 * counts. Adding a harness = one more parser here (Copilot, Gemini, Aider, Cursor…).
 */
export function indexAllHarnesses(db: DatabaseSync): HarnessResults {
  return {
    "claude-code": indexClaudeTranscripts(db),
    codex: indexCodexSessions(db),
    gemini: indexGeminiSessions(db),
    continue: indexContinueSessions(db),
    cursor: indexCursorSessions(db),
    "amazon-q": indexAmazonQSessions(db),
    kiro: indexKiroSessions(db),
    droid: indexDroidSessions(db),
    aider: indexAiderSessions(db),
    antigravity: indexAntigravitySessions(db),
    cline: indexClineSessions(db),
    opencode: indexOpenCodeSessions(db),
  };
}
