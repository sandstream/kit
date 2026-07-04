/**
 * kit memory — Factory Droid transcript parser (multi-harness).
 *
 * Factory's `droid` CLI is Claude-Code-compatible and persists per-session
 * transcripts as JSONL under ~/.factory/projects/<projectHash>/<session-uuid>.jsonl
 * — the same line-oriented shape as Claude Code (one JSON record per line, with a
 * `type`/`message.role` + `message.content` block array). We index the user/
 * assistant turns, tag harness="droid", and reuse the Claude content flattener.
 *
 * Reads are DEFENSIVE: a record's role is taken from `type` | `message.role` |
 * `role`, and its text from the Claude block-array shape with a plain-string
 * fallback, so a line that matches no known shape indexes nothing rather than
 * wrong text. RAW + idempotent + incremental (file_index) + fail-safe; no model
 * calls. Only ~/.factory/projects/ is globbed — the ~/.factory/sessions/ path is
 * uncorroborated and deliberately left out.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import { extractText, type IndexResult } from "./parser.js";

export function getDroidProjectsDir(): string {
  const base = process.env.KIT_DROID_DIR ?? join(homedir(), ".factory");
  return join(base, "projects");
}

interface DroidRecord {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  role?: string;
  content?: unknown;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/** Resolve a user/assistant role from the record, or "" if it is neither. */
function roleOf(rec: DroidRecord): "user" | "assistant" | "" {
  const raw = rec.type ?? rec.message?.role ?? rec.role ?? "";
  return raw === "user" || raw === "assistant" ? raw : "";
}

/** Flatten a record's content: Claude block-array shape, else a plain string. */
function contentOf(rec: DroidRecord): string {
  const c = rec.message?.content ?? rec.content;
  if (typeof c === "string") return c;
  // extractText handles the Claude {type:"text"|"tool_use"|"tool_result"} blocks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return extractText(c as any);
}

function* walkTranscripts(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTranscripts(p);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield p;
  }
}

function indexFile(db: DatabaseSync, filepath: string): { messages: number } {
  let raw: string;
  try {
    raw = readFileSync(filepath, "utf8");
  } catch {
    return { messages: 0 };
  }

  const fallbackSession = basename(filepath, ".jsonl");
  let sessionId = fallbackSession;
  let cwd: string | undefined;
  let messages = 0;
  let idx = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let seededSession = false;

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec: DroidRecord;
    try {
      rec = JSON.parse(t) as DroidRecord;
    } catch {
      continue;
    }

    if (!seededSession) {
      if (typeof rec.sessionId === "string" && rec.sessionId) sessionId = rec.sessionId;
      if (typeof rec.cwd === "string") cwd = rec.cwd;
      upsertSession(db, {
        sessionId,
        harness: "droid",
        project: cwd ? basename(cwd) : undefined,
      });
      seededSession = true;
    } else if (!cwd && typeof rec.cwd === "string") {
      cwd = rec.cwd;
    }

    const role = roleOf(rec);
    if (!role) continue;
    const content = contentOf(rec).trim();
    if (!content) continue;

    const ts = rec.timestamp;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }

    const added = insertMessage(db, {
      // Prefer the record's own uuid; else a stable per-session index → idempotent.
      uuid: rec.uuid ?? `droid:${sessionId}:${idx}`,
      sessionId,
      type: role,
      role,
      content,
      timestamp: ts,
      cwd,
    });
    idx++;
    if (added) messages++;
  }

  if (seededSession) {
    upsertSession(db, {
      sessionId,
      harness: "droid",
      project: cwd ? basename(cwd) : undefined,
      firstMessageAt: firstTs,
      lastMessageAt: lastTs,
    });
  }
  return { messages };
}

/** Walk ~/.factory/projects and index every transcript. Idempotent + incremental. */
export function indexDroidSessions(db: DatabaseSync): IndexResult {
  const dir = getDroidProjectsDir();
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  if (!existsSync(dir)) return result;

  for (const filepath of walkTranscripts(dir)) {
    let st;
    try {
      st = statSync(filepath);
    } catch {
      continue;
    }
    const mtimeMs = Math.floor(st.mtimeMs);
    if (isFileIndexed(db, filepath, mtimeMs, st.size)) {
      result.filesSkipped++;
      continue;
    }
    const counts = indexFile(db, filepath);
    markFileIndexed(db, filepath, mtimeMs, st.size);
    result.files++;
    if (counts.messages > 0) result.sessions++;
    result.messages += counts.messages;
  }
  return result;
}
