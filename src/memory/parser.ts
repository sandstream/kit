/**
 * kit memory — Claude Code transcript parser.
 *
 * Reads raw session transcripts from ~/.claude/projects/<project>/<session>.jsonl
 * and indexes them into the memory store. RAW + idempotent: one row per message
 * (deduped by uuid), no summarisation. Re-running is safe — already-seen messages
 * are ignored. Field mapping mirrors the Claude Code transcript format (also used
 * by cloudctx, MIT). Other harnesses (Codex/Cursor) get their own parser later;
 * sessions carry a `harness` tag so the store stays multi-harness.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  insertMessage,
  insertToolUse,
  upsertSession,
  isFileIndexed,
  markFileIndexed,
} from "./db.js";

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

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}
type Content = string | ContentBlock[] | undefined;

/** Flatten transcript content (string or block array) into searchable plain text. */
export function extractText(content: Content): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b?.type === "text") return b.text ?? "";
        if (b?.type === "tool_use") return `[Tool: ${b.name ?? "unknown"}]`;
        if (b?.type === "tool_result") return "[Tool Result]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
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
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

function indexFile(
  db: DatabaseSync,
  filepath: string,
  project: string,
): { messages: number; toolUses: number } {
  const sessionId = basename(filepath, ".jsonl");
  let raw: string;
  try {
    raw = readFileSync(filepath, "utf8");
  } catch {
    return { messages: 0, toolUses: 0 };
  }

  // Ensure the session row exists before inserting messages so per-message
  // counters resolve against a real row.
  upsertSession(db, { sessionId, harness: "claude-code", project });

  let messages = 0;
  let toolUses = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let isSidechain = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(trimmed) as TranscriptRecord;
    } catch {
      continue; // skip malformed lines, keep indexing the rest
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;
    if (!rec.uuid) continue;
    if (rec.isSidechain) isSidechain = true;

    const msg = rec.message;
    const ts = rec.timestamp;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    const added = insertMessage(db, {
      uuid: rec.uuid,
      sessionId: rec.sessionId ?? sessionId,
      parentUuid: rec.parentUuid,
      type: rec.type,
      role: msg?.role,
      content: extractText(msg?.content),
      model: msg?.model,
      inputTokens: msg?.usage?.input_tokens,
      outputTokens: msg?.usage?.output_tokens,
      timestamp: ts,
      cwd: rec.cwd,
      gitBranch: rec.gitBranch,
      version: rec.version,
    });

    if (added) {
      messages++;
      for (const tool of extractToolUses(msg?.content)) {
        insertToolUse(db, {
          messageUuid: rec.uuid,
          sessionId: rec.sessionId ?? sessionId,
          toolName: tool.name,
          toolInput: tool.input,
          timestamp: ts,
        });
        toolUses++;
      }
    }
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

  return { messages, toolUses };
}

/** Walk ~/.claude/projects and index every transcript. Idempotent. */
export function indexClaudeTranscripts(db: DatabaseSync): IndexResult {
  const projectsDir = getClaudeProjectsDir();
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  if (!existsSync(projectsDir)) return result;

  for (const projectName of readdirSync(projectsDir).sort()) {
    const projectPath = join(projectsDir, projectName);
    let isDir = false;
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
      if (isFileIndexed(db, filePath, mtimeMs, st.size)) {
        result.filesSkipped++;
        continue;
      }
      const counts = indexFile(db, filePath, projectName);
      markFileIndexed(db, filePath, mtimeMs, st.size);
      result.files++;
      result.sessions++;
      result.messages += counts.messages;
      result.toolUses += counts.toolUses;
    }
  }
  return result;
}
