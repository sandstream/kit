/**
 * Attribute recorded requests to explicit Skill invocation spans without running a skill.
 * Only a returned Skill invocation opens a span. A denied invocation leaves it unchanged.
 * An unresolved invocation ends certain attribution. Later calls remain unattributed until
 * another returned invocation establishes a boundary. Automatic activation has no span.
 *
 * Outcomes describe transcript responses, not execution or effects. Legacy rows remain unknown.
 * The DB reader checks capture completeness for all messages in relevant sessions.
 * A signed broker policy adds target scope checks. Structured audit denials can supply evidence.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ObservedAction, RuntimeEvidence } from "./adherence.js";
import { toolOutcome, type ToolOutcome } from "../memory/tool-events.js";
import { checkEgress, checkFsWrite } from "../exec-broker/decisions.js";
import { policyFsRoots, type BrokerPolicy } from "../exec-broker/policy.js";
import { extractHostsFromCommand } from "../broker/extract.js";

/** One ordered tool-call row from `tool_uses`, reduced to what attribution needs. */
export interface ToolCallRow {
  sessionId: string;
  tool: string;
  /** Raw `tool_input` JSON (for egress/fs target-scope verdicts); null when absent. */
  input: string | null;
  /** ISO timestamp of the call (for denial→span time-window attribution); "" when absent. */
  timestamp: string;
  /** For a `Skill` row, the invoked skill slug (parsed from `tool_input`); else null. */
  opensSkill: string | null;
  /** Missing outcomes are legacy requests without result evidence. */
  outcome?: ToolOutcome;
}

/**
 * A target invocation window `[start, end)` in one session. An empty end means session end.
 * Only returned invocations supply starts. Denied invocations do not close a window.
 * Other Skill requests end the window. Missing boundary timestamps cannot establish a window.
 */
export interface SpanWindow {
  sessionId: string;
  start: string;
  end: string;
}

/** Compute certain target windows from rows ordered by `(session_id, id)`. Pure. */
export function targetSpanWindows(rows: ToolCallRow[], target: string): SpanWindow[] {
  const windows: SpanWindow[] = [];
  let curSession: string | null = null;
  let openTarget: { start: string } | null = null; // an open target span awaiting its end

  const closeOpen = (end: string): void => {
    if (openTarget && curSession !== null) {
      windows.push({ sessionId: curSession, start: openTarget.start, end });
      openTarget = null;
    }
  };

  for (const row of rows) {
    if (row.sessionId !== curSession) {
      closeOpen(""); // previous session's open target span runs to session end
      curSession = row.sessionId;
    }
    if (row.tool === "Skill") {
      if (row.outcome === "denied") continue;
      if (row.timestamp) closeOpen(row.timestamp);
      else openTarget = null; // No timestamp means no safe denial window.
      if (row.opensSkill === target && row.outcome === "returned" && row.timestamp)
        openTarget = { start: row.timestamp };
    }
  }
  closeOpen(""); // final open target span runs to session end
  return windows;
}

/** Per-action broker verdict from a signed scope, or undefined when the action carries no target. */
export type BrokerVerdict = "in-scope" | "out-of-scope" | undefined;

/** Pull a string field from a row's `tool_input` JSON; null on absent/unparseable/non-string. */
function inputField(input: string | null, key: string): string | null {
  if (input == null) return null;
  try {
    const v = (JSON.parse(input) as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Egress/fs target-scope verdict for a recorded action against a signed broker policy — the
 * SAME decisions the gate-egress / gate-fs enforcers apply, pointed at a transcript row.
 *   - Bash: extract hosts from the command; any host outside `policy.egress.allow` → out-of-scope.
 *   - WebFetch: its `url` checked against the egress allowlist.
 *   - Write/Edit: its `file_path` must land under some allowed fs root.
 *   - Any other tool, or a tool with no extractable target → undefined (tool-scope still applies).
 * Pure. Deterministic given (row, policy).
 */
export function brokerVerdictForRow(
  tool: string,
  input: string | null,
  policy: BrokerPolicy,
): BrokerVerdict {
  if (tool === "Bash") {
    const command = inputField(input, "command");
    if (command === null) return undefined;
    const hosts = extractHostsFromCommand(command);
    if (hosts.length === 0) return undefined;
    return hosts.every((h) => checkEgress(h, { allow: policy.egress.allow }).ok)
      ? "in-scope"
      : "out-of-scope";
  }
  if (tool === "WebFetch") {
    const url = inputField(input, "url");
    if (url === null) return undefined;
    return checkEgress(url, { allow: policy.egress.allow }).ok ? "in-scope" : "out-of-scope";
  }
  if (tool === "Write" || tool === "Edit") {
    const path = inputField(input, "file_path");
    if (path === null) return undefined;
    return policyFsRoots(policy).some((root) => checkFsWrite(path, root).ok)
      ? "in-scope"
      : "out-of-scope";
  }
  return undefined;
}

/**
 * Parse the skill slug a row opens: a `Skill` tool call whose `tool_input` JSON is
 * `{ "skill": "<slug>", ... }`. Any other tool, or unparseable/blank input, opens no span.
 * Pure — never throws.
 */
export function parseSkillOpen(tool: string, toolInput: string | null | undefined): string | null {
  if (tool !== "Skill") return null;
  if (toolInput == null) return null;
  let slug: unknown;
  try {
    slug = (JSON.parse(toolInput) as { skill?: unknown }).skill;
  } catch {
    return null;
  }
  if (typeof slug !== "string") return null;
  const s = slug.trim();
  return s.length > 0 ? s : null;
}

function observedAction(
  row: ToolCallRow,
  verdictOf?: (row: ToolCallRow) => BrokerVerdict,
): ObservedAction {
  return {
    tool: row.tool,
    denied: row.outcome === "denied",
    outcome: row.outcome ?? "unknown",
    brokerVerdict: verdictOf?.(row),
  };
}

/**
 * Attribute rows ordered by `(session_id, id)` to returned target invocations.
 * Skill rows define boundaries and are not actions. Uncertain spans only contribute gap counts.
 * Explicit denials do not replace an active span. Session changes always end attribution.
 */
export function attributeRuns(
  rows: ToolCallRow[],
  target: string,
  verdictOf?: (row: ToolCallRow) => BrokerVerdict,
): RuntimeEvidence {
  const actions: ObservedAction[] = [];
  const sessionsWithSpan = new Set<string>();
  let runs = 0;
  let curSession: string | null = null;
  let active = false;
  let possibleTarget = false;
  let unresolvedInvocations = 0;
  let unattributedActions = 0;
  let deniedInvocations = 0;

  for (const row of rows) {
    if (row.sessionId !== curSession) {
      curSession = row.sessionId;
      active = false;
      possibleTarget = false;
    }
    if (row.tool === "Skill") {
      if (row.outcome === "denied") {
        if (row.opensSkill === target) deniedInvocations++;
        continue;
      }
      const returned = row.outcome === "returned" && row.opensSkill !== null;
      possibleTarget = !returned && (active || possibleTarget || row.opensSkill === target);
      if (possibleTarget) unresolvedInvocations++;
      active = returned && row.opensSkill === target;
      if (active) {
        runs++;
        sessionsWithSpan.add(row.sessionId);
      }
      continue; // the Skill row opens/closes a span; it is not itself an action
    }
    if (active) actions.push(observedAction(row, verdictOf));
    else if (possibleTarget) unattributedActions++;
  }

  return {
    actions,
    runs,
    sessions: sessionsWithSpan.size,
    confidence: "span",
    unresolvedInvocations,
    unattributedActions,
    deniedInvocations,
  };
}

/** Read ordered `tool_uses` rows (by `session_id, id`) so spans reconstruct exactly. */
export function readToolCallRows(db: DatabaseSync): ToolCallRow[] {
  const hasOutcome = db
    .prepare("PRAGMA table_info(tool_uses)")
    .all()
    .some((column) => column.name === "outcome");
  const raw = db
    .prepare(
      `SELECT session_id, tool_name, tool_input, timestamp, ${hasOutcome ? "outcome" : "'unknown' AS outcome"} FROM tool_uses ORDER BY session_id, id`,
    )
    .all() as {
    session_id: string | null;
    tool_name: string | null;
    tool_input: string | null;
    timestamp: string | null;
    outcome: unknown;
  }[];
  return raw.map((r) => ({
    sessionId: r.session_id ?? "",
    tool: (r.tool_name ?? "").trim(),
    input: r.tool_input,
    timestamp: r.timestamp ?? "",
    opensSkill: parseSkillOpen(r.tool_name ?? "", r.tool_input),
    outcome: toolOutcome(r.outcome),
  }));
}

/** A message with no tool rows is still a gap unless the parser recorded full capture. */
function readCaptureCoverage(
  db: DatabaseSync,
  sessions: Set<string>,
): NonNullable<RuntimeEvidence["capture"]> {
  const columns = db.prepare("PRAGMA table_info(messages)").all();
  const supported = ["tool_capture_version", "tool_capture_count"].every((name) =>
    columns.some((column) => column.name === name),
  );
  if (!columns.length || sessions.size === 0) return { complete: false, incompleteMessages: 0 };
  const captured = `CASE WHEN tool_capture_version = 1 AND typeof(tool_capture_count) = 'integer'
    AND tool_capture_count >= 0 AND tool_capture_count =
    (SELECT COUNT(*) FROM tool_uses t WHERE t.message_uuid = m.uuid AND t.session_id = m.session_id)
    THEN 0 ELSE 1 END`;
  const count = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(${supported ? captured : "1"}), 0) AS incomplete
    FROM messages m WHERE session_id = ?`);
  const orphans = db.prepare(`SELECT COUNT(*) AS total FROM tool_uses t
    LEFT JOIN messages m ON m.uuid = t.message_uuid AND m.session_id = t.session_id
    WHERE t.session_id = ? AND m.uuid IS NULL`);
  let incompleteMessages = 0;
  let complete = supported;
  for (const session of sessions) {
    // SQLite COUNT and COALESCE(SUM, 0) return numeric aggregates, not timestamps.
    const counts = count.get(session)! as { total: number; incomplete: number };
    const orphanCount = orphans.get(session)! as { total: number };
    const missing = counts.incomplete + orphanCount.total;
    incompleteMessages += missing;
    if (counts.total === 0 || missing > 0) complete = false;
  }
  return { complete, incompleteMessages };
}

/**
 * Attribute the memory DB's recorded runs to `target`. With a signed broker policy, each action
 * is enriched with an egress/fs target-scope verdict (without one, tool-scope adherence still
 * applies). `denialActions` (attributed from the audit log, `denials.ts`) are appended so the
 * negative-control check can see denied-and-blocked forbidden attempts. Deterministic given the
 * DB + inputs; the pure `attributeRuns` does the decision.
 */
export function readRunEvidence(
  db: DatabaseSync,
  target: string,
  opts: { policy?: BrokerPolicy | null; denialActions?: ObservedAction[] } = {},
): RuntimeEvidence {
  const rows = readToolCallRows(db);
  const verdictOf = opts.policy
    ? (row: ToolCallRow) => brokerVerdictForRow(row.tool, row.input, opts.policy as BrokerPolicy)
    : undefined;
  const evidence = attributeRuns(rows, target, verdictOf);
  const sessions = new Set(
    rows.filter((row) => row.opensSkill === target).map((row) => row.sessionId),
  );
  evidence.capture = readCaptureCoverage(db, sessions);
  const denialActions = opts.denialActions ?? [];
  if (denialActions.length === 0) return evidence;
  return { ...evidence, actions: [...evidence.actions, ...denialActions] };
}
