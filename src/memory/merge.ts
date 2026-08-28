/**
 * kit memory — merge another store into this one.
 *
 * Consolidate memory across machines (a server, an old laptop) into one brain.
 * Idempotent: messages dedupe by uuid, sessions/pending/threads by their keys, and
 * a message's tool_uses are copied only when the message itself is newly added, so
 * re-merging the same source adds nothing. `file_index` is NOT merged (it tracks
 * machine-local file paths). Deterministic; no model calls.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { insertMessage, insertToolUse, upsertSession } from "./db.js";

export interface MergeResult {
  sessions: number;
  messages: number;
  toolUses: number;
  tombstones: number;
  tombstoneDeletedMessages: number;
  tombstoneBlockedMessages: number;
  pending: number;
  threads: number;
  /**
   * Sessions imported per project key (AFTER any remap). Lets the CLI say loudly
   * which scopes the merge landed in — a foreign key (e.g. a container's
   * "-home-user") is invisible to project-scoped search, and "merged" must not
   * read as "reachable" when it is not (#247).
   */
  projects: Record<string, number>;
}

export interface MergeOpts {
  /**
   * Rewrite every imported session's project key to this project root, so
   * sessions from another machine/container join the scope they belong to
   * instead of staying under a foreign path like "-home-user" (#247).
   */
  remapProject?: string;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Project keys are stored in the Claude-projects form: path with / → -. */
export function projectKeyFor(projectRoot: string): string {
  return projectRoot.replace(/\//g, "-");
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function mergeTombstones(target: DatabaseSync, src: DatabaseSync, out: MergeResult): void {
  if (!tableExists(src, "memory_tombstones")) return;
  const upsert = target.prepare(
    `INSERT INTO memory_tombstones (uuid, content_sha256, session_id, reason, deleted_at)
     VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
     ON CONFLICT(uuid) DO UPDATE SET
       content_sha256 = excluded.content_sha256,
       session_id = COALESCE(excluded.session_id, memory_tombstones.session_id),
       reason = COALESCE(excluded.reason, memory_tombstones.reason),
       deleted_at = CASE
         WHEN excluded.deleted_at > memory_tombstones.deleted_at THEN excluded.deleted_at
         ELSE memory_tombstones.deleted_at
       END
     WHERE
       memory_tombstones.content_sha256 IS NOT excluded.content_sha256 OR
       memory_tombstones.session_id IS NOT excluded.session_id OR
       memory_tombstones.reason IS NOT excluded.reason OR
       memory_tombstones.deleted_at IS NOT excluded.deleted_at`,
  );
  const existingMessage = target.prepare("SELECT session_id FROM messages WHERE uuid = ?");
  const deleteMessage = target.prepare("DELETE FROM messages WHERE uuid = ?");
  const deleteToolUses = target.prepare("DELETE FROM tool_uses WHERE message_uuid = ?");
  const decSession = target.prepare(
    "UPDATE sessions SET message_count = MAX(message_count - 1, 0) WHERE session_id = ?",
  );

  for (const t of src.prepare("SELECT * FROM memory_tombstones").all() as Row[]) {
    const uuid = str(t.uuid);
    const contentSha = str(t.content_sha256);
    if (!uuid || !contentSha) continue;
    const existing = existingMessage.get(uuid) as { session_id: string } | undefined;
    if (existing) {
      deleteMessage.run(uuid);
      deleteToolUses.run(uuid);
      decSession.run(existing.session_id);
      out.tombstoneDeletedMessages++;
    }
    const r = upsert.run(
      uuid,
      contentSha,
      (str(t.session_id) ?? null) as string | null,
      (str(t.reason) ?? null) as string | null,
      (str(t.deleted_at) ?? null) as string | null,
    );
    if (Number(r.changes) > 0) out.tombstones++;
  }
}

export function mergeDb(
  target: DatabaseSync,
  sourcePath: string,
  opts: MergeOpts = {},
): MergeResult {
  if (!existsSync(sourcePath)) throw new Error(`source memory db not found: ${sourcePath}`);
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  const out: MergeResult = {
    sessions: 0,
    messages: 0,
    toolUses: 0,
    tombstones: 0,
    tombstoneDeletedMessages: 0,
    tombstoneBlockedMessages: 0,
    pending: 0,
    threads: 0,
    projects: {},
  };
  const remapKey = opts.remapProject ? projectKeyFor(opts.remapProject) : undefined;

  try {
    // Tombstones must land before messages: a deletion record wins over stale
    // rows from another machine and blocks future resurrection by uuid (#549).
    mergeTombstones(target, src, out);

    // Sessions
    for (const s of src.prepare("SELECT * FROM sessions").all() as Row[]) {
      const sessionId = str(s.session_id);
      if (!sessionId) continue;
      const project = remapKey ?? str(s.project);
      upsertSession(target, {
        sessionId,
        harness: str(s.harness) ?? "claude-code",
        project,
        firstMessageAt: str(s.first_message_at),
        lastMessageAt: str(s.last_message_at),
        isAgentSidechain: !!s.is_agent_sidechain,
      });
      out.sessions++;
      const key = project ?? "(no project)";
      out.projects[key] = (out.projects[key] ?? 0) + 1;
    }

    // tool_uses grouped by message uuid (copied only for newly-added messages)
    const toolsByUuid = new Map<string, Row[]>();
    for (const t of src.prepare("SELECT * FROM tool_uses").all() as Row[]) {
      const uuid = str(t.message_uuid);
      if (!uuid) continue;
      (toolsByUuid.get(uuid) ?? toolsByUuid.set(uuid, []).get(uuid)!).push(t);
    }

    // Messages (dedupe by uuid) + their tool_uses
    for (const m of src.prepare("SELECT * FROM messages").all() as Row[]) {
      const uuid = str(m.uuid);
      const sessionId = str(m.session_id);
      const type = str(m.type);
      if (!uuid || !sessionId || !type) continue; // need a stable id to dedupe
      if (target.prepare("SELECT 1 FROM memory_tombstones WHERE uuid = ?").get(uuid)) {
        out.tombstoneBlockedMessages++;
        continue;
      }
      const added = insertMessage(target, {
        uuid,
        sessionId,
        parentUuid: str(m.parent_uuid),
        type,
        role: str(m.role),
        content: str(m.content),
        model: str(m.model),
        inputTokens: num(m.input_tokens),
        outputTokens: num(m.output_tokens),
        timestamp: str(m.timestamp),
        cwd: str(m.cwd),
        gitBranch: str(m.git_branch),
        version: str(m.version),
      });
      if (!added) continue;
      out.messages++;
      for (const t of toolsByUuid.get(uuid) ?? []) {
        insertToolUse(target, {
          messageUuid: uuid,
          sessionId: str(t.session_id),
          toolName: str(t.tool_name) ?? "unknown",
          toolInput: str(t.tool_input),
          timestamp: str(t.timestamp),
        });
        out.toolUses++;
      }
    }

    // Pending actions (dedupe by id)
    const insPending = target.prepare(
      `INSERT OR IGNORE INTO pending_actions
       (id, status, title, detail, scope, kind, verify_cmd, created_at, next_check, snooze_until, closed_at, verify_passes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of src.prepare("SELECT * FROM pending_actions").all() as Row[]) {
      if (!str(p.id) || !str(p.title)) continue;
      const r = insPending.run(
        p.id as string,
        str(p.status) ?? "open",
        p.title as string,
        (str(p.detail) ?? null) as string | null,
        (str(p.scope) ?? null) as string | null,
        // SECURITY: never carry an executable verify_cmd across a DB merge — a
        // command from another machine's store is not operator-authored in this
        // session. Demote merged pending actions to `manual` with no verify_cmd
        // (same invariant as importLegacyLedger) so palAutoVerify can't execute a
        // command that crossed the merge boundary. Re-add via `pal add` to re-arm.
        "manual",
        null,
        (str(p.created_at) ?? null) as string | null,
        (str(p.next_check) ?? null) as string | null,
        (str(p.snooze_until) ?? null) as string | null,
        (str(p.closed_at) ?? null) as string | null,
        num(p.verify_passes) ?? 0,
      );
      if (Number(r.changes) > 0) out.pending++;
    }

    // Saved threads (dedupe by name)
    const insThread = target.prepare(
      `INSERT OR IGNORE INTO saved_threads (name, session_id, summary, project_path, saved_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const t of src.prepare("SELECT * FROM saved_threads").all() as Row[]) {
      const name = str(t.name);
      const sid = str(t.session_id);
      if (!name || !sid) continue;
      const r = insThread.run(
        name,
        sid,
        (str(t.summary) ?? null) as string | null,
        (str(t.project_path) ?? null) as string | null,
        (str(t.saved_at) ?? null) as string | null,
      );
      if (Number(r.changes) > 0) out.threads++;
    }
  } finally {
    src.close();
  }
  return out;
}
