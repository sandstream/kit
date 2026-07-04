/**
 * kit memory — Aider transcript parser (multi-harness).
 *
 * Aider is the one PROJECT-LOCAL harness: it writes its chat log as markdown to
 * `$GIT_ROOT/.aider.chat.history.md` (cwd fallback), not a `~/.<agent>` tree. The
 * format is deterministic:
 *   - `# aider chat started at <ts>`  → a session delimiter
 *   - lines prefixed `#### `          → a user turn (one turn = a run of them)
 *   - plain unprefixed lines          → the assistant response
 *   - lines prefixed `> `             → aider's own output (commits, shell) — skipped
 * We index the user/assistant turns, tag harness="aider", and synthesize stable
 * uuids so re-indexing is idempotent. Content is taken verbatim (no model calls);
 * a `#### ` line inside an assistant block is the one inherent ambiguity of the
 * markdown format — it mislabels a role at worst, never fabricates content.
 *
 * Resolution order for the log file: KIT_AIDER_HISTORY (test/override) →
 * AIDER_CHAT_HISTORY_FILE (aider's own env) → <cwd>/.aider.chat.history.md.
 */
import { existsSync, statSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { insertMessage, upsertSession, isFileIndexed, markFileIndexed } from "./db.js";
import type { IndexResult } from "./parser.js";

export function getAiderHistoryFile(cwd: string = process.cwd()): string {
  return (
    process.env.KIT_AIDER_HISTORY ??
    process.env.AIDER_CHAT_HISTORY_FILE ??
    resolve(cwd, ".aider.chat.history.md")
  );
}

type Role = "user" | "assistant";

function indexHistory(db: DatabaseSync, file: string): { messages: number } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { messages: 0 };
  }

  const cwd = dirname(file);
  let sessionIdx = -1;
  let sessionId = "";
  let msgIdx = 0;
  let role: Role | null = null;
  let buf: string[] = [];
  let messages = 0;

  const ensureSession = () => {
    if (sessionIdx < 0) {
      // A log with turns but no explicit "started at" header → session 0.
      sessionIdx = 0;
      sessionId = `aider:${file}:0`;
      upsertSession(db, { sessionId, harness: "aider", project: cwd });
    }
  };

  const flush = () => {
    if (role && buf.length) {
      const content = buf.join("\n").trim();
      if (content) {
        ensureSession();
        const added = insertMessage(db, {
          uuid: `${sessionId}:${msgIdx}:${role}`,
          sessionId,
          type: role,
          role,
          content,
          cwd,
        });
        msgIdx++;
        if (added) messages++;
      }
    }
    buf = [];
    role = null;
  };

  for (const line of raw.split("\n")) {
    if (/^# aider chat started at/.test(line)) {
      flush();
      sessionIdx++;
      sessionId = `aider:${file}:${sessionIdx}`;
      msgIdx = 0;
      upsertSession(db, { sessionId, harness: "aider", project: cwd });
      continue;
    }
    if (line.startsWith("#### ") || line === "####") {
      if (role !== "user") flush();
      role = "user";
      buf.push(line.slice(4).replace(/^ /, ""));
      continue;
    }
    if (line.startsWith("> ") || line === ">") {
      // aider's own output (commit/shell echoes) — a hard boundary, not indexed.
      flush();
      continue;
    }
    if (line.trim() === "") {
      // Keep blank lines only inside an active message (paragraph spacing).
      if (role) buf.push("");
      continue;
    }
    // Any other non-empty line is assistant prose.
    if (role !== "assistant") flush();
    role = "assistant";
    buf.push(line);
  }
  flush();
  return { messages };
}

/** Index the project's .aider.chat.history.md. Idempotent + incremental + fail-safe. */
export function indexAiderSessions(db: DatabaseSync, cwd: string = process.cwd()): IndexResult {
  const result: IndexResult = { files: 0, sessions: 0, messages: 0, toolUses: 0, filesSkipped: 0 };
  const file = getAiderHistoryFile(cwd);
  if (!existsSync(file)) return result;

  let st;
  try {
    st = statSync(file);
  } catch {
    return result;
  }
  const mtimeMs = Math.floor(st.mtimeMs);
  if (isFileIndexed(db, file, mtimeMs, st.size)) {
    result.filesSkipped++;
    return result;
  }

  const counts = indexHistory(db, file);
  markFileIndexed(db, file, mtimeMs, st.size);
  result.files++;
  if (counts.messages > 0) result.sessions++;
  result.messages += counts.messages;
  return result;
}
