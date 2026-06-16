/**
 * kit memory — Gemini CLI transcript parser (multi-harness).
 *
 * Gemini CLI persists conversation state under ~/.gemini/tmp/<projectHash>/ via a
 * few mechanisms. Formats verified against the google-gemini/gemini-cli source:
 *   - logs.json — a JSON array of LogEntry records
 *       { sessionId, messageId, timestamp, type, message }
 *   - checkpoint files — either { history: Content[] } (modern) or a bare
 *       Content[] (legacy), where Content = { role: 'user'|'model', parts:[{text}] }
 *
 * We index user + model turns from whichever are present, tag harness="gemini",
 * synthesize stable uuids (idempotent), and STRUCTURALLY skip non-conversation
 * JSON (e.g. file-snapshot checkpoints whose shape isn't Content[]). RAW +
 * deterministic; no model calls.
 *
 * Limitation: Gemini keys directories by a one-way projectHash, so the real repo
 * path isn't recoverable — Gemini messages carry no cwd and surface in `--global`
 * recall rather than project-scoped search.
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import type { IndexResult } from "./parser.js";

export function getGeminiTmpDir(): string {
  const base = process.env.KIT_GEMINI_DIR ?? join(homedir(), ".gemini");
  return join(base, "tmp");
}

interface GeminiContent {
  role?: string;
  parts?: { text?: string }[];
}
interface LogEntry {
  sessionId?: string;
  messageId?: number;
  timestamp?: string;
  type?: string;
  message?: string;
}

function partsText(parts: { text?: string }[] | undefined): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => p?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

/** Coerce a parsed checkpoint to Content[], or null if it isn't a conversation. */
function asHistory(parsed: unknown): GeminiContent[] | null {
  if (Array.isArray(parsed)) {
    const looksLikeContent = parsed.every(
      (x) => x !== null && typeof x === "object" && ("role" in x || "parts" in x),
    );
    return looksLikeContent ? (parsed as GeminiContent[]) : null;
  }
  if (parsed !== null && typeof parsed === "object") {
    const h = (parsed as Record<string, unknown>).history;
    if (Array.isArray(h)) return h as GeminiContent[];
  }
  return null;
}

/** Map a Gemini role/sender to the store's user|assistant. */
function roleOf(raw: string | undefined): "user" | "assistant" {
  return raw === "user" ? "user" : "assistant"; // 'model'/'gemini'/etc → assistant
}

function indexLogs(db: DatabaseSync, filepath: string): { messages: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filepath, "utf8"));
  } catch {
    return { messages: 0 };
  }
  if (!Array.isArray(parsed)) return { messages: 0 };

  let messages = 0;
  let idx = 0;
  for (const entry of parsed as LogEntry[]) {
    const text = typeof entry?.message === "string" ? entry.message : "";
    if (!text) continue;
    const sessionId = `gemini:${entry.sessionId ?? basename(filepath)}`;
    upsertSession(db, { sessionId, harness: "gemini" });
    const added = insertMessage(db, {
      uuid: `gemini:log:${entry.sessionId ?? basename(filepath)}:${entry.messageId ?? idx}`,
      sessionId,
      type: roleOf(entry.type),
      role: roleOf(entry.type),
      content: text,
      timestamp: entry.timestamp,
    });
    idx++;
    if (added) messages++;
  }
  return { messages };
}

function indexCheckpoint(db: DatabaseSync, filepath: string): { messages: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filepath, "utf8"));
  } catch {
    return { messages: 0 };
  }
  const history = asHistory(parsed);
  if (!history) return { messages: 0 }; // not a conversation checkpoint — skip

  const sessionId = `gemini-ckpt:${basename(filepath, ".json")}`;
  upsertSession(db, { sessionId, harness: "gemini" });
  let messages = 0;
  history.forEach((c, idx) => {
    if (c?.role !== "user" && c?.role !== "model") return; // skip non-turn entries
    const text = partsText(c.parts);
    if (!text) return;
    const added = insertMessage(db, {
      uuid: `gemini:ckpt:${basename(filepath)}:${idx}`,
      sessionId,
      type: roleOf(c.role),
      role: roleOf(c.role),
      content: text,
    });
    if (added) messages++;
  });
  return { messages };
}

interface GeminiFile {
  path: string;
  kind: "logs" | "checkpoint";
}

function* walkGeminiFiles(tmpDir: string): Generator<GeminiFile> {
  let hashes;
  try {
    hashes = readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const h of hashes) {
    if (!h.isDirectory()) continue;
    const projDir = join(tmpDir, h.name);
    const logs = join(projDir, "logs.json");
    if (existsSync(logs)) yield { path: logs, kind: "logs" };
    // checkpoint JSON lives at the project root and/or in a checkpoints/ subdir
    for (const dir of [projDir, join(projDir, "checkpoints")]) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".json") && e.name !== "logs.json") {
          yield { path: join(dir, e.name), kind: "checkpoint" };
        }
      }
    }
  }
}

/** Walk ~/.gemini/tmp and index every conversation log/checkpoint. Idempotent + incremental. */
export function indexGeminiSessions(db: DatabaseSync): IndexResult {
  const tmpDir = getGeminiTmpDir();
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  if (!existsSync(tmpDir)) return result;

  for (const f of walkGeminiFiles(tmpDir)) {
    let st;
    try {
      st = statSync(f.path);
    } catch {
      continue;
    }
    const mtimeMs = Math.floor(st.mtimeMs);
    if (isFileIndexed(db, f.path, mtimeMs, st.size)) {
      result.filesSkipped++;
      continue;
    }
    const counts = f.kind === "logs" ? indexLogs(db, f.path) : indexCheckpoint(db, f.path);
    markFileIndexed(db, f.path, mtimeMs, st.size);
    result.files++;
    result.sessions++;
    result.messages += counts.messages;
  }
  return result;
}
