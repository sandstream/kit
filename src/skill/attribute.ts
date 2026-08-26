/**
 * `kit skill test` P2b — attribute recorded tool calls to a skill's runs (transcript).
 * kit never runs a skill (zero-LLM). It reads what the agent already recorded: the memory
 * index normalizes every transcript into `tool_uses` (one row per call, ordered by `id`).
 * A skill run is a SPAN — a `Skill` tool call opens it (`tool_input` carries the slug), and
 * the tool calls that follow, until the next `Skill` call or the session ends, are that
 * skill's actions. Intersecting spans with tool usage yields per-skill runtime evidence,
 * which `adherence.ts` turns into the scope-adherence + negative-control verdicts.
 *
 * The pure core (`parseSkillOpen`, `attributeRuns`) is deterministic and unit-tested; the
 * thin `readRunEvidence` reads the ordered rows from the DB and delegates to it.
 *
 * SCOPE OF THIS INCREMENT (stated honestly, surfaced in the command output):
 *   - Confidence is `span` — bounded by explicit `Skill` invocations. Skills that
 *     auto-activate without a `Skill` call leave no span → no runs → honest skip.
 *   - `denied` is always false here: the transcript records calls that RAN. A gate deny
 *     blocks a call before it runs and lands in `.kit-audit.jsonl`, not `tool_uses` — so
 *     denial-based "control held" evidence needs an audit-log join (a later increment).
 *   - Only TOOL-scope adherence is judged (tool ∈ declared allowed-tools). Egress/fs
 *     TARGET-scope adherence (broker verdict per target) is a later increment.
 */
import type { DatabaseSync } from "node:sqlite";
import type { ObservedAction, RuntimeEvidence } from "./adherence.js";
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
}

/**
 * The time window of one target-skill run within a session: `[start, end)`. `start` is the
 * `Skill` call's timestamp; `end` is the NEXT `Skill` call's timestamp in the same session, or
 * "" (open — until session end). A denial at time T belongs to the span with `start ≤ T < end`
 * in the SAME session — precise, session-bounded attribution, not a global timestamp guess.
 */
export interface SpanWindow {
  sessionId: string;
  start: string;
  end: string;
}

/**
 * Compute the target skill's run windows from ordered rows (by `session_id, id`). Each `Skill`
 * row opens a span whose end is the next `Skill` row's timestamp in that session (any skill), or
 * "" at session end. Only the target skill's windows are returned. Pure.
 */
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
    if (row.opensSkill !== null) {
      closeOpen(row.timestamp); // any new skill closes the prior target span at its start
      if (row.opensSkill === target) openTarget = { start: row.timestamp };
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

/**
 * Attribute ordered rows to the target skill's runs. Rows MUST be ordered by
 * (session_id, id). Within a session, a `Skill` row opens a span; while the open span is
 * the target skill, following non-`Skill` rows become its actions; a new `Skill` row (or a
 * session change) closes the span. The `Skill` row itself is a boundary, never an action.
 * Pure. Confidence is always `span` (we have explicit run boundaries).
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

  for (const row of rows) {
    if (row.sessionId !== curSession) {
      curSession = row.sessionId;
      active = false;
    }
    if (row.opensSkill !== null) {
      active = row.opensSkill === target;
      if (active) {
        runs++;
        sessionsWithSpan.add(row.sessionId);
      }
      continue; // the Skill row opens/closes a span; it is not itself an action
    }
    if (active) actions.push({ tool: row.tool, denied: false, brokerVerdict: verdictOf?.(row) });
  }

  return { actions, runs, sessions: sessionsWithSpan.size, confidence: "span" };
}

/** Read ordered `tool_uses` rows (by `session_id, id`) so spans reconstruct exactly. */
export function readToolCallRows(db: DatabaseSync): ToolCallRow[] {
  const raw = db
    .prepare(
      "SELECT session_id, tool_name, tool_input, timestamp FROM tool_uses ORDER BY session_id, id",
    )
    .all() as {
    session_id: string | null;
    tool_name: string | null;
    tool_input: string | null;
    timestamp: string | null;
  }[];
  return raw.map((r) => ({
    sessionId: r.session_id ?? "",
    tool: (r.tool_name ?? "").trim(),
    input: r.tool_input,
    timestamp: r.timestamp ?? "",
    opensSkill: parseSkillOpen(r.tool_name ?? "", r.tool_input),
  }));
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
  const denialActions = opts.denialActions ?? [];
  if (denialActions.length === 0) return evidence;
  return { ...evidence, actions: [...evidence.actions, ...denialActions] };
}
