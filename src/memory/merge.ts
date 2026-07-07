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
    pending: 0,
    threads: 0,
    projects: {},
  };
  const remapKey = opts.remapProject ? projectKeyFor(opts.remapProject) : undefined;

  try {
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
