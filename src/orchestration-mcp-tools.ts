/**
 * MCP tools that start or steer another agent: a nested-agent launch that goes through no shell.
 *
 * T3 Code gives the agents it starts an MCP server whose tools launch more agents (`delegate_task`,
 * `t3_thread_launch`, `t3_thread_send`, …), and outside agents get the same tools over its `/mcp`
 * endpoint. A new thread runs at the project's default permission mode, Full access unless changed,
 * and a child "never exceeds its parent's mode", which is Full access by default (kit-research#241).
 * `gate-bash` refuses `t3 thread start` on the command line (src/nested-agent-bypass.ts), but these
 * calls are MCP tools, which no kit matcher selected. kit now wires `gate-bash` to the tool names
 * below as well (Claude Code and Codex both send an MCP call to PreToolUse as
 * `mcp__<server>__<tool>`), and refuses them the same way.
 *
 * Tool names and descriptions from pingdotgg/t3code 0.1.13, read as data
 * (`apps/server/src/mcp/toolkits/{orchestrator,project,thread,workflow,attachment}/tools.ts`):
 * - `delegate_task`: "Start one child agent".
 * - `t3_thread_launch`: starts a thread with a message, in the project or a new worktree.
 * - `t3_thread_send`: "starts an idle thread, steers a running turn, or queues";
 *   `t3_thread_send_attachments` sends the same message with files.
 * - `create_threads`: "Create new top-level threads".
 * - `schedule_task`: "scheduled work that runs with no turn active"; `run_scheduled_task_now`.
 * - `t3_workflow`: durable workflows. Only its `start`, `resume` and `signal` actions run or wake one,
 *   so the read and store actions pass; an action kit does not know is refused (fail-closed).
 *
 * The server name is the user's choice, so any server's tool of these names is refused. Pure.
 */

/** The tools, and what calling one does. */
const LAUNCH_TOOLS: Record<string, string> = {
  delegate_task: "starts a child agent",
  t3_thread_launch: "starts an agent thread",
  t3_thread_send: "starts or steers an agent thread",
  t3_thread_send_attachments: "starts or steers an agent thread",
  create_threads: "creates agent threads",
  schedule_task: "schedules an agent run with nobody watching",
  run_scheduled_task_now: "runs a scheduled agent task",
  t3_workflow: "starts or wakes a durable agent workflow",
};

/** `t3_workflow` actions that neither start nor wake a run. */
const WORKFLOW_PASSES = new Set([
  "list",
  "read",
  "questions",
  "hooks",
  "store",
  "store_set",
  "store_delete",
  "withdraw",
  "cancel",
]);

/**
 * The PreToolUse matcher for these tools. A regular expression in both harnesses: Claude Code reads
 * any matcher with other characters than letters, digits, `_`, `-`, `,`, `|` and spaces as one
 * (https://code.claude.com/docs/en/hooks, "Matcher patterns"); Codex matchers are regular expressions
 * (kit writes `^Bash$` there).
 */
export const ORCHESTRATION_MCP_MATCHER = `^mcp__.+__(${Object.keys(LAUNCH_TOOLS).join("|")})$`;

/** What was caught: the full tool name and what it does. */
export interface OrchestrationLaunch {
  tool: string;
  what: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The orchestration launch in a PreToolUse payload (`tool_name`, `tool_input`), or null. Pure. */
export function orchestrationLaunch(payload: unknown): OrchestrationLaunch | null {
  const p = (payload ?? {}) as { tool_name?: unknown; tool_input?: unknown };
  const tool = str(p.tool_name) ?? "";
  const name = /^mcp__.+__([A-Za-z0-9_-]+)$/.exec(tool)?.[1];
  const what = name === undefined ? undefined : LAUNCH_TOOLS[name];
  if (what === undefined) return null;
  if (name === "t3_workflow") {
    const action = str((p.tool_input as { action?: unknown } | undefined)?.action);
    if (action !== undefined && WORKFLOW_PASSES.has(action)) return null;
  }
  return { tool, what };
}

/** The refusal for `gate-bash`, or null. */
export function orchestrationRefusal(payload: unknown): string | null {
  const found = orchestrationLaunch(payload);
  if (!found) return null;
  return (
    `${found.tool} ${found.what}: a nested agent, started through an MCP tool, at a permission ` +
    "mode this session cannot see (T3 Code's default is Full access, approvals off), so it would " +
    "run commands nobody approves, outside this session's permission prompts. Ask the person to " +
    "start it. Running an agent unattended is the person's decision, not the agent's (fail-closed)"
  );
}
