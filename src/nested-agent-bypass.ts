/**
 * A nested coding agent started with its approvals off.
 *
 * `claude --print --dangerously-skip-permissions "…"`, `codex exec --yolo "…"` and `gemini --yolo
 * -p "…"` start a second agent that runs every command without asking anyone. `gate-bash` passed
 * all of them (kit-research `artex-cc-vs-kit`), while it refuses `git commit --no-verify` for the
 * same reason: it skips a control. The gate names the agent and the flag, and says how to run the
 * same agent with approvals on.
 *
 * Shared, pure and stable: `agent-audit` reads permission grants (`Bash(claude --print
 * --dangerously-skip-permissions:*)`) with the same table. `nestedAgentBypass` takes a shell
 * command string or one argv; `nestedAgentCli` names the agent behind a command word.
 *
 * An orchestrator that starts the agent itself is matched by subcommand instead: `t3 thread start`
 * starts a T3 Code agent at the project's runtime mode, which is Full access unless changed, and no
 * flag on that command can set it (kit-research#241). Such a launch is refused whatever its flags.
 *
 * Only flags the vendor documents are listed, each with its source. Read without execution, through
 * the carriers in `gate-bash-carriers` (`sh -c '…'`, `$(…)`, `powershell -EncodedCommand`, …).
 */
import { readThroughCarriers, type CommandReader } from "./gate-bash-carriers.js";
import { bin } from "./install-gate-hooks.js";

/** What was caught. */
export interface NestedAgentBypass {
  /** The agent, by its command name: `claude`, `codex`, `gemini`, … */
  agent: string;
  /** The approval-off argument as the command spelled it, e.g. `--permission-mode bypassPermissions`. */
  flag: string;
  /** How to run the same agent with its approvals on. */
  approvalsOn: string;
  /** Set when the command cannot say what mode the agent runs in: what kit knows of it instead. */
  mode?: string;
}

/** An option and the value that turns approvals off. */
type OptionValue = [names: string[], value: string];

interface Harness {
  agent: string;
  /** Switches that turn approvals off on their own. */
  flags: string[];
  /** Options whose value turns approvals off on its own. */
  options: OptionValue[];
  /** Options that turn approvals off only together (Codex `-a never` with `-s danger-full-access`). */
  together: OptionValue[];
  /** An environment assignment before the command that turns approvals off. */
  env?: RegExp;
  /** Subcommands that start or steer an agent whose mode no flag sets: refused on their own. */
  launches?: string[][];
  /** For `launches`: the mode the started agent runs in, as far as kit knows. */
  mode?: string;
  approvalsOn: string;
}

const HARNESSES: Harness[] = [
  {
    // https://code.claude.com/docs/en/cli-reference — `--dangerously-skip-permissions`: "Skip
    // permission prompts. Equivalent to `--permission-mode bypassPermissions`."
    agent: "claude",
    flags: ["--dangerously-skip-permissions"],
    options: [[["--permission-mode"], "bypasspermissions"]],
    together: [],
    approvalsOn:
      "Drop the flag: the nested session then asks before each tool, and `--allowedTools` pre-approves only the tools it needs.",
  },
  {
    // https://learn.chatgpt.com/docs/developer-commands?surface=cli (developers.openai.com/codex/cli/
    // reference redirects there) — `--dangerously-bypass-approvals-and-sandbox`
    // (alias `--yolo`): "Run every command without approvals or sandboxing." `--ask-for-approval`
    // (`-a`) takes `never`; `--sandbox` (`-s`) takes `danger-full-access`.
    agent: "codex",
    flags: ["--dangerously-bypass-approvals-and-sandbox", "--yolo"],
    options: [],
    together: [
      [["-a", "--ask-for-approval"], "never"],
      [["-s", "--sandbox"], "danger-full-access"],
    ],
    approvalsOn:
      "Drop the flag: `--sandbox workspace-write --ask-for-approval on-request` keeps both the sandbox and the approvals.",
  },
  {
    // https://geminicli.com/docs/cli/cli-reference/ — `--yolo` / `-y`: "Auto-approve all
    // actions." `--approval-mode`: "Choices: `default`, `auto_edit`, `yolo`, `plan`".
    agent: "gemini",
    flags: ["--yolo", "-y"],
    options: [[["--approval-mode"], "yolo"]],
    together: [],
    approvalsOn: "Use `--approval-mode default`, which asks before each tool.",
  },
  {
    // https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md —
    // `--yolo`: "automatically approves all tool calls"; `--approval-mode` `yolo` is the same.
    agent: "qwen",
    flags: ["--yolo"],
    options: [[["--approval-mode"], "yolo"]],
    together: [],
    approvalsOn: "Use `--approval-mode default`, which asks before each tool.",
  },
  {
    // https://cursor.com/docs/cli/reference/parameters — `-f, --force`: "Force allow commands
    // unless explicitly denied"; `--yolo`: "Alias for `--force`". The binary is `agent`;
    // `cursor-agent` is its earlier name.
    agent: "cursor-agent",
    flags: ["--force", "-f", "--yolo"],
    options: [],
    together: [],
    approvalsOn: "Drop `--force`: the agent then asks before each command.",
  },
  {
    // https://docs.github.com/en/copilot/reference/cli-command-reference — `--allow-all-tools`:
    // "Grant blanket tool permissions without … individual approval prompts" (env:
    // COPILOT_ALLOW_ALL); `--allow-all` and `--yolo`: "Enable all permissions".
    agent: "copilot",
    flags: ["--allow-all-tools", "--allow-all", "--yolo"],
    options: [],
    together: [],
    env: /^COPILOT_ALLOW_ALL=\s*(true|1|yes|on|y)\s*$/i,
    approvalsOn: "Grant single tools with `--allow-tool` instead of all of them.",
  },
  {
    // https://kiro.dev/docs/reference/cli-commands/ — `kiro-cli chat --trust-all-tools`: "Allow
    // the model to use any tool without confirmation".
    agent: "kiro-cli",
    flags: ["--trust-all-tools"],
    options: [],
    together: [],
    approvalsOn: "Name the tools it needs with `--trust-tools` instead of trusting all of them.",
  },
  {
    // https://docs.factory.com/cli/droid-exec/overview — `--skip-permissions-unsafe`: "Skip all
    // permission prompts (unsafe)".
    agent: "droid",
    flags: ["--skip-permissions-unsafe"],
    options: [],
    together: [],
    approvalsOn: "Use `--auto low` or `--auto medium`, which keep Droid's permission checks.",
  },
  {
    // pingdotgg/t3code 0.1.13 (read as data): `t3 thread start` calls the server's
    // `t3_thread_launch`, `t3 thread send` its `t3_thread_send` (apps/server/src/cli/thread.ts);
    // `t3 workflow start|resume` runs durable workflows (cli/workflow.ts). None takes a permission
    // mode. A new thread starts at `defaultRuntimeMode`, `DEFAULT_RUNTIME_MODE = "full-access"`
    // (packages/contracts/src/providerPolicy.ts), which is Claude `bypassPermissions` and Codex
    // `danger-full-access` (docs/user/permission-modes.md).
    agent: "t3",
    flags: [],
    options: [],
    together: [],
    launches: [
      ["thread", "start"],
      ["thread", "send"],
      ["workflow", "start"],
      ["workflow", "resume"],
    ],
    mode: "T3 Code runs it at the project's default permission mode, which is Full access (approvals off) unless changed, and no flag on this command sets it",
    approvalsOn:
      "Ask the person to start it from T3 Code, after setting Settings → Threads → New threads → Permissions below Full access.",
  },
];

const BY_AGENT = new Map(HARNESSES.map((h) => [h.agent, h]));
// Command names, and the npm packages `npx` / `npm exec` run them from.
const CLIS = new Map<string, string>([
  ["claude", "claude"],
  ["@anthropic-ai/claude-code", "claude"],
  ["codex", "codex"],
  ["@openai/codex", "codex"],
  ["gemini", "gemini"],
  ["@google/gemini-cli", "gemini"],
  ["qwen", "qwen"],
  ["@qwen-code/qwen-code", "qwen"],
  ["agent", "cursor-agent"],
  ["cursor-agent", "cursor-agent"],
  ["copilot", "copilot"],
  ["@github/copilot", "copilot"],
  ["kiro-cli", "kiro-cli"],
  ["droid", "droid"],
  ["t3", "t3"],
]);

/**
 * The agent a command word starts, or null: `claude`, `/usr/local/bin/codex`, `gemini.cmd`,
 * `@anthropic-ai/claude-code@2.1.0`. Pure; stable for `agent-audit`.
 */
export function nestedAgentCli(word: string): string | null {
  const pkg = word.toLowerCase().replace(/(.)@[^/@]*$/, "$1");
  if (pkg.startsWith("@")) return CLIS.get(pkg) ?? null;
  return CLIS.get(bin(word).replace(/\.(cmd|ps1|bat)$/, "")) ?? null;
}

/** Arguments before `--`: after it, everything is the prompt or the child's. */
function options(args: readonly string[]): string[] {
  const end = args.indexOf("--");
  return end < 0 ? [...args] : args.slice(0, end);
}

/** `--opt value` or `--opt=value` with the off value, spelled as the command spelled it. */
function optionHit(args: string[], [names, value]: OptionValue): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    if (eq > 0 && names.includes(a.slice(0, eq)) && a.slice(eq + 1).toLowerCase() === value)
      return a;
    if (names.includes(a) && (args[i + 1] ?? "").toLowerCase() === value)
      return `${a} ${args[i + 1]}`;
  }
  return null;
}

function flagHit(args: string[], flags: string[]): string | null {
  return args.find((a) => flags.includes(a) || flags.some((f) => a === `${f}=true`)) ?? null;
}

/** A launch subcommand pair, next to each other among the options: `thread start`. */
function launchHit(opts: string[], launches: string[][]): string | null {
  for (const pair of launches) {
    if (opts.some((a, i) => pair.every((w, k) => opts[i + k] === w))) return pair.join(" ");
  }
  return null;
}

function harnessHit(h: Harness, args: readonly string[], env: string[]): string | null {
  const opts = options(args);
  if (h.launches) return launchHit(opts, h.launches);
  const found =
    env.find((e) => h.env?.test(e)) ??
    flagHit(opts, h.flags) ??
    h.options.map((o) => optionHit(opts, o)).find(Boolean);
  if (found) return found;
  const all = h.together.map((o) => optionHit(opts, o));
  return all.length > 0 && all.every(Boolean) ? all.join(" ") : null;
}

const READER: CommandReader<NestedAgentBypass> = {
  isTarget: (word) => nestedAgentCli(word) !== null,
  read(head, args, env) {
    const harness = BY_AGENT.get(nestedAgentCli(head)!)!;
    const flag = harnessHit(harness, args, env);
    if (!flag) return null;
    const found = { agent: harness.agent, flag, approvalsOn: harness.approvalsOn };
    return harness.mode ? { ...found, mode: harness.mode } : found;
  },
};

/**
 * The nested agent with approvals off in `command`, or null. `command` is a shell command string,
 * or one argv (`["claude", "-p", "--dangerously-skip-permissions"]`). Pure; stable for
 * `agent-audit`.
 */
export function nestedAgentBypass(command: string | readonly string[]): NestedAgentBypass | null {
  return readThroughCarriers(command, READER);
}

/** The refusal: the agent, the flag, how to run it with approvals on, and who decides. */
export function nestedAgentBypassReason(found: NestedAgentBypass): string {
  if (found.mode) {
    return (
      `starts or steers a nested agent (${found.agent} ${found.flag}): ${found.mode}, so it would ` +
      "run commands nobody approves, outside this session's permission prompts. " +
      `${found.approvalsOn} Running an agent unattended is the person's decision, not the agent's (fail-closed)`
    );
  }
  return (
    `starts a nested agent with its approvals off (${found.agent} ${found.flag}): it would run ` +
    `commands nobody approves, outside this session's permission prompts. ${found.approvalsOn} ` +
    "Running an agent unattended is the person's decision, not the agent's (fail-closed)"
  );
}

/** The gate's refusal for `decideBashGate`, read from the command with data-only here-documents removed. */
export function nestedAgentRefusal(heredocs: {
  command: string;
  expansions: string[];
}): string | null {
  const found = [heredocs.command, ...heredocs.expansions]
    .map((c) => nestedAgentBypass(c))
    .find(Boolean);
  return found ? nestedAgentBypassReason(found) : null;
}
