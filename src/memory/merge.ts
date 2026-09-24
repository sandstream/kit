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
import { resolve } from "node:path";
import { upsertSession } from "./db.js";
import { createProjectMapper, type MergeScopeOptions } from "./remap.js";
import { mergeMessages, type MergedMessages } from "./merge-messages.js";
import { mergePendingActions, type MergedActions } from "./merge-actions.js";
import { assertCausalTables, assertNoOrphanActionHistory } from "./pal-revisions.js";
import { assertSupportedMemorySchema } from "./db-schema.js";
import { mergeProjectIdentities } from "./project.js";

export interface MergeResult extends MergedMessages, MergedActions {
  sessions: number;
  tombstones: number;
  tombstoneDeletedMessages: number;
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

export type MergeOpts = MergeScopeOptions;

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const nullableStr = (value: unknown): string | null => str(value) ?? null;

/** Project keys are stored in the Claude-projects form: path with / → -. */
export function projectKeyFor(projectRoot: string): string {
  return projectRoot.split("/").join("-");
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

function mergeThreads(
  target: DatabaseSync,
  src: DatabaseSync,
  out: MergeResult,
  mapProject: ReturnType<typeof createProjectMapper>,
): void {
  const insert = target.prepare(
    `INSERT OR IGNORE INTO saved_threads (name, session_id, summary, project_path, saved_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const remap = target.prepare(
    "UPDATE saved_threads SET recall_project_path = ? WHERE name = ? AND session_id = ? AND project_path IS ? AND recall_project_path IS NOT ?",
  );
  for (const row of src.prepare("SELECT * FROM saved_threads").all()) {
    const name = str(row.name);
    const sessionId = str(row.session_id);
    if (!name || !sessionId) continue;
    out.threads += Number(
      insert.run(
        name,
        sessionId,
        nullableStr(row.summary),
        nullableStr(row.project_path),
        nullableStr(row.saved_at),
      ).changes,
    );
    const recallPath = mapProject(str(row.project_path));
    if (recallPath)
      out.scopeRepairs += Number(
        remap.run(recallPath, name, sessionId, nullableStr(row.project_path), recallPath).changes,
      );
  }
}

export function mergeDb(
  target: DatabaseSync,
  sourcePath: string,
  opts: MergeOpts = {},
): MergeResult {
  if (!existsSync(sourcePath)) throw new Error(`source memory db not found: ${sourcePath}`);
  const mapProject = createProjectMapper(opts);
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  const out: MergeResult = {
    sessions: 0,
    messages: 0,
    toolUses: 0,
    tombstones: 0,
    tombstoneDeletedMessages: 0,
    tombstoneBlockedMessages: 0,
    pending: 0,
    pendingScopeRepairs: 0,
    pendingIdRemaps: 0,
    pendingStateDifferences: 0,
    pendingDifferenceIds: [],
    pendingLegacySnapshots: 0,
    threads: 0,
    scopeRepairs: 0,
    protectionRepairs: 0,
    projects: {},
  };
  const remapKey = opts.remapProject ? projectKeyFor(resolve(opts.remapProject)) : undefined;

  try {
    target.exec("SAVEPOINT kit_memory_merge");
    src.exec("BEGIN");
    assertSupportedMemorySchema(target);
    assertCausalTables(src);
    assertNoOrphanActionHistory(src, target);
    mergeProjectIdentities(target, src);
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

    Object.assign(out, mergeMessages(target, src, mapProject));

    Object.assign(out, mergePendingActions(target, src, mapProject));
    out.scopeRepairs += out.pendingScopeRepairs;
    mergeThreads(target, src, out, mapProject);
    target.exec("RELEASE kit_memory_merge");
  } catch (error) {
    target.exec("ROLLBACK TO kit_memory_merge; RELEASE kit_memory_merge");
    throw error;
  } finally {
    src.close();
  }
  return out;
}
