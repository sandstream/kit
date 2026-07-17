/**
 * `kit skill test` P2b — attribute recorded tool calls to a skill's runs (transcript).
 *
 * Design: `kit-research/docs/research/skill-test-p2-runtime-adherence.md`.
 *
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

/** One ordered tool-call row from `tool_uses`, reduced to what attribution needs. */
export interface ToolCallRow {
  sessionId: string;
  tool: string;
  /** For a `Skill` row, the invoked skill slug (parsed from `tool_input`); else null. */
  opensSkill: string | null;
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
export function attributeRuns(rows: ToolCallRow[], target: string): RuntimeEvidence {
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
    if (active) actions.push({ tool: row.tool, denied: false });
  }

  return { actions, runs, sessions: sessionsWithSpan.size, confidence: "span" };
}

/**
 * Read ordered `tool_uses` rows from the memory DB and attribute them to `target`. The
 * ORDER BY (session_id, id) reproduces per-session call order so spans reconstruct exactly.
 * Deterministic given the DB. The pure `attributeRuns` does the decision.
 */
export function readRunEvidence(db: DatabaseSync, target: string): RuntimeEvidence {
  const raw = db
    .prepare("SELECT session_id, tool_name, tool_input FROM tool_uses ORDER BY session_id, id")
    .all() as { session_id: string | null; tool_name: string | null; tool_input: string | null }[];
  const rows: ToolCallRow[] = raw.map((r) => ({
    sessionId: r.session_id ?? "",
    tool: (r.tool_name ?? "").trim(),
    opensSkill: parseSkillOpen(r.tool_name ?? "", r.tool_input),
  }));
  return attributeRuns(rows, target);
}
