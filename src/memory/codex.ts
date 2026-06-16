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

function indexFile(db: DatabaseSync, filepath: string): { messages: number } {
  let raw: string;
  try {
    raw = readFileSync(filepath, "utf8");
  } catch {
    return { messages: 0 };
  }

  let sessionId = basename(filepath, ".jsonl");
  let cwd: string | undefined;
  let project: string | undefined;
  let messages = 0;
  let idx = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec: CodexLine;
    try {
      rec = JSON.parse(t) as CodexLine;
    } catch {
      continue;
    }

    if (rec.type === "session_meta") {
      const p = rec.payload ?? {};
      if (typeof p.id === "string") sessionId = p.id;
      if (typeof p.cwd === "string") {
        cwd = p.cwd;
        project = basename(p.cwd);
      }
      upsertSession(db, { sessionId, harness: "codex", project });
      continue;
    }

    if (rec.type === "response_item" && rec.payload?.type === "message") {
      const role = String(rec.payload.role ?? "");
      if (role !== "user" && role !== "assistant") continue; // skip developer/system noise
      const ts = rec.timestamp;
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }
      const added = insertMessage(db, {
        uuid: `codex:${sessionId}:${idx}`, // stable per-session index → idempotent
        sessionId,
        type: role === "assistant" ? "assistant" : "user",
        role,
        content: textOf(rec.payload.content),
        timestamp: ts,
        cwd,
      });
      idx++;
      if (added) messages++;
    }
  }

  upsertSession(db, {
    sessionId,
    harness: "codex",
    project,
    firstMessageAt: firstTs,
    lastMessageAt: lastTs,
  });
  return { messages };
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
    if (isFileIndexed(db, filepath, mtimeMs, st.size)) {
      result.filesSkipped++;
      continue;
    }
    const counts = indexFile(db, filepath);
    markFileIndexed(db, filepath, mtimeMs, st.size);
    result.files++;
    result.sessions++;
    result.messages += counts.messages;
  }
  return result;
}
