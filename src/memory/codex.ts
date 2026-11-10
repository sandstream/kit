/**
 * kit memory — Codex CLI transcript parser (multi-harness).
 *
 * Reads OpenAI Codex rollout logs from ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl.
 * Each line is { timestamp, type, payload }: a `session_meta` line carries the
 * session id + cwd; `response_item` lines of payload.type "message" carry the actual
 * turns (role + content blocks). We index user/assistant turns (developer/system
 * context is noise), tag them harness="codex", and synthesize a stable per-message
 * uuid so re-indexing is idempotent. RAW + deterministic; no model calls.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import type { IndexResult } from "./parser.js";
import { captureCodexTool } from "./codex-tools.js";
import {
  captureTranscript,
  transcriptRecord,
  TOOL_CAPTURE_VERSION,
  type TranscriptTools,
} from "./transcript-tools.js";

export function getCodexSessionsDir(): string {
  const base = process.env.KIT_CODEX_DIR ?? join(homedir(), ".codex");
  return join(base, "sessions");
}

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}
interface ContentBlock {
  type?: string;
  text?: string;
}

/** Flatten Codex content blocks (input_text / output_text / text) to plain text. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .map((b) =>
      b?.type === "input_text" || b?.type === "output_text" || b?.type === "text"
        ? (b.text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function* walkRollouts(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkRollouts(p);
    else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      yield p;
    }
  }
}

function indexFile(
  db: DatabaseSync,
  filepath: string,
): { messages: number; toolUses: number; retry: boolean } | undefined {
  let raw: string;
  try {
    raw = readFileSync(filepath, "utf8");
  } catch {
    console.error("kit: could not read Codex transcript; capture remains incomplete");
    return;
  }
  return captureTranscript(db, (tools) =>
    indexRecords(db, raw, basename(filepath, ".jsonl"), tools),
  );
}

interface CodexSession {
  sessionId: string;
  cwd?: string;
  project?: string;
  messages: number;
  idx: number;
  firstTs?: string;
  lastTs?: string;
}

function indexRecords(
  db: DatabaseSync,
  raw: string,
  sessionId: string,
  tools: TranscriptTools,
): { messages: number; toolUses: number } {
  const session: CodexSession = { sessionId, messages: 0, idx: 0 };
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const rec = transcriptRecord(text, tools) as CodexLine | undefined;
    if (!rec) continue;
    if (rec.type === "session_meta") {
      const payload = rec.payload ?? {};
      if (typeof payload.id === "string") session.sessionId = payload.id;
      if (typeof payload.cwd === "string") {
        session.cwd = payload.cwd;
        session.project = basename(payload.cwd);
      }
      upsertSession(db, {
        sessionId: session.sessionId,
        harness: "codex",
        project: session.project,
      });
    } else if (rec.type === "response_item") {
      captureResponse(db, tools, rec, session);
    } else if (rec.type === "event_msg") {
      if (!isConversationEvent(rec.payload?.type)) tools.complete = false;
    } else if (rec.type !== "turn_context") {
      tools.complete = false;
    }
  }
  upsertSession(db, {
    sessionId: session.sessionId,
    harness: "codex",
    project: session.project,
    firstMessageAt: session.firstTs,
    lastMessageAt: session.lastTs,
  });
  return { messages: session.messages, toolUses: tools.added };
}

function captureResponse(
  db: DatabaseSync,
  tools: TranscriptTools,
  rec: CodexLine,
  session: CodexSession,
): void {
  const { sessionId, cwd, project } = session;
  upsertSession(db, { sessionId, harness: "codex", project });
  const payload = rec.payload ?? {};
  if (payload.type !== "message") {
    session.messages += captureCodexTool(db, tools, payload, {
      sessionId,
      timestamp: rec.timestamp,
      cwd,
    });
    return;
  }
  const role = capturedRole(payload.role, tools);
  if (!role) return;
  const ts = rec.timestamp;
  if (ts) {
    session.firstTs ??= ts;
    session.lastTs = ts;
  }
  session.messages += storeCodexMessage(db, tools, payload, {
    uuid: `codex:${sessionId}:${session.idx++}`,
    sessionId,
    timestamp: ts,
    cwd,
    role,
  });
}

function isConversationEvent(type: unknown): boolean {
  return [
    "user_message",
    "agent_message",
    "agent_reasoning",
    "token_count",
    "task_started",
    "task_complete",
    "turn_aborted",
    "context_compacted",
  ].includes(String(type));
}

function capturedRole(value: unknown, tools: TranscriptTools): "user" | "assistant" | undefined {
  if (value === "user" || value === "assistant") return value;
  if (value !== "developer" && value !== "system") tools.complete = false;
  return undefined;
}

function storeCodexMessage(
  db: DatabaseSync,
  tools: TranscriptTools,
  payload: Record<string, unknown>,
  parent: { uuid: string; sessionId: string; timestamp?: string; cwd?: string; role: string },
): number {
  const { uuid, sessionId, timestamp: ts, cwd, role } = parent;
  const blocks = payload.content;
  if (
    !Array.isArray(blocks) ||
    blocks.some(
      (b: ContentBlock) =>
        !["input_text", "output_text", "text", "input_image", "image", "refusal"].includes(
          b?.type ?? "",
        ),
    )
  )
    tools.complete = false;
  const added = insertMessage(db, {
    uuid,
    sessionId,
    type: role === "assistant" ? "assistant" : "user",
    role,
    content: textOf(payload.content),
    timestamp: ts,
    cwd,
  });
  tools.message(uuid, sessionId);
  return added ? 1 : 0;
}

/** Walk ~/.codex/sessions and index every rollout. Idempotent + incremental (file_index). */
export function indexCodexSessions(db: DatabaseSync): IndexResult {
  const dir = getCodexSessionsDir();
  const result: IndexResult = {
    files: 0,
    sessions: 0,
    messages: 0,
    toolUses: 0,
    filesSkipped: 0,
  };
  if (!existsSync(dir)) return result;

  for (const filepath of walkRollouts(dir)) {
    let st;
    try {
      st = statSync(filepath);
    } catch {
      continue;
    }
    const mtimeMs = Math.floor(st.mtimeMs);
    if (isFileIndexed(db, filepath, mtimeMs, st.size, TOOL_CAPTURE_VERSION)) {
      result.filesSkipped++;
      continue;
    }
    const counts = indexFile(db, filepath);
    if (!counts) continue;
    if (!counts.retry) markFileIndexed(db, filepath, mtimeMs, st.size, TOOL_CAPTURE_VERSION);
    result.files++;
    result.sessions++;
    result.messages += counts.messages;
    result.toolUses += counts.toolUses;
  }
  return result;
}
