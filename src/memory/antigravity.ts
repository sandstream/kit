/**
 * kit memory — Google Antigravity transcript parser (multi-harness).
 *
 * Antigravity (Gemini-family IDE/CLI) stores per-conversation JSONL "brain" logs
 * under ~/.gemini/{antigravity-cli,antigravity-ide,antigravity}/brain/<id>/
 * .system_generated/logs/transcript_full.jsonl (preferred; falls back to the
 * truncated transcript.jsonl). The existing gemini.ts reads only ~/.gemini/tmp,
 * so this is a real, separate gap. One JSON object per line; we map the record's
 * `source`/`type` to a role (USER_INPUT → user, MODEL/PLANNER_RESPONSE →
 * assistant), tag harness="antigravity", and flatten content defensively. The
 * opaque protobuf `.pb` conversation DB is NOT text-indexable and is ignored.
 * Read-only, idempotent, incremental, fail-safe; no model calls.
 */
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import type { IndexResult } from "./parser.js";

/** The three Antigravity brain roots under ~/.gemini (CLI, IDE, and 2.0). */
export function getAntigravityRoots(): string[] {
  const base = process.env.KIT_ANTIGRAVITY_DIR ?? join(homedir(), ".gemini");
  return ["antigravity-cli", "antigravity-ide", "antigravity"].map((seg) => join(base, seg));
}

type Role = "user" | "assistant";

/** Map an Antigravity record's source/type enum to a role, or null to skip. */
function roleOf(rec: Record<string, unknown>): Role | null {
  const tag = String(rec.source ?? rec.type ?? rec.role ?? "").toUpperCase();
  if (tag.includes("USER")) return "user";
  if (tag.includes("MODEL") || tag.includes("PLANNER") || tag.includes("ASSISTANT")) {
    return "assistant";
  }
  return null;
}

/** Defensively pull text from a string | {content|text|message|parts} | array. */
function textOf(node: unknown, depth = 0): string {
  if (typeof node === "string") return node;
  if (depth > 4 || node === null || typeof node !== "object") return "";
  if (Array.isArray(node)) {
    return node
      .map((n) => textOf(n, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  const obj = node as Record<string, unknown>;
  for (const field of ["content", "text", "message", "prompt", "parts"]) {
    const v = obj[field];
    if (typeof v === "string" && v.trim()) return v;
    if (v && typeof v === "object") {
      const nested = textOf(v, depth + 1);
      if (nested) return nested;
    }
  }
  return "";
}

/** Yield the preferred transcript file per brain conversation dir. */
function* walkTranscripts(root: string): Generator<string> {
  const brain = join(root, "brain");
  let convs: string[];
  try {
    convs = readdirSync(brain, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }
  for (const conv of convs) {
    const logDir = join(brain, conv, ".system_generated", "logs");
    const full = join(logDir, "transcript_full.jsonl");
    const truncated = join(logDir, "transcript.jsonl");
    if (existsSync(full)) yield full;
    else if (existsSync(truncated)) yield truncated;
  }
}

function indexFile(db: DatabaseSync, filepath: string, sessionId: string): { messages: number } {
  let raw: string;
  try {
    raw = readFileSync(filepath, "utf8");
  } catch {
    return { messages: 0 };
  }

  upsertSession(db, { sessionId, harness: "antigravity" });
  let messages = 0;
  let idx = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role = roleOf(rec);
    if (!role) continue;
    const content = textOf(rec).trim();
    if (!content) continue;
    const added = insertMessage(db, {
      uuid: `antigravity:${sessionId}:${idx}:${role}`,
      sessionId,
      type: role,
      role,
      content,
    });
    idx++;
    if (added) messages++;
  }
  return { messages };
}

/** Walk every ~/.gemini/antigravity-* brain conversation and index its transcript. */
export function indexAntigravitySessions(db: DatabaseSync): IndexResult {
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  for (const root of getAntigravityRoots()) {
    for (const filepath of walkTranscripts(root)) {
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
      // Session id = the conversation dir name (…/brain/<id>/.system_generated/…).
      const parts = filepath.split(/[/\\]/);
      const brainIdx = parts.lastIndexOf("brain");
      const conv = brainIdx >= 0 && parts[brainIdx + 1] ? parts[brainIdx + 1] : filepath;
      const counts = indexFile(db, filepath, `antigravity:${conv}`);
      markFileIndexed(db, filepath, mtimeMs, st.size);
      result.files++;
      if (counts.messages > 0) result.sessions++;
      result.messages += counts.messages;
    }
  }
  return result;
}
