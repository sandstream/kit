/**
 * Copilot CLI's camelCase \`preToolUse\` payload carries the tool arguments in \`toolArgs\`, which its
 * docs type as \`unknown\`: an object, or the arguments as a JSON string. The command is read from
 * either. Anything else gives undefined.
 */
export function toolArgsCommand(payload: unknown): unknown {
  const args = (payload as { toolArgs?: unknown } | null)?.toolArgs;
  if (typeof args !== "string") return (args as { command?: unknown } | undefined)?.command;
  try {
    return (JSON.parse(args) as { command?: unknown } | null)?.command;
  } catch {
    return undefined;
  }
}

/**
 * Cline's shell tool is `run_commands`, legacy alias `execute_command` (cline/cline
 * `sdk/packages/core/src/runtime/orchestration/runtime-builder.ts:109`, commit cbc7d141).
 */
const CLINE_SHELL_TOOLS = new Set(["run_commands", "execute_command"]);

/**
 * POSIX single-quoting: the gate re-parses the joined line as shell, and it must see the same
 * argv that Cline runs. A word of only safe characters stays bare.
 */
function shQuote(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * A `{command, args}` entry, which Cline runs without a shell (`StructuredCommandInputSchema`,
 * `sdk/packages/core/src/extensions/tools/schemas.ts:133-142`). Each word is quoted, so an
 * argument with spaces, quotes, `;` or `&&` stays one argument. Undefined when the argv cannot be
 * written as shell words: `args` is not a list of strings, or a word holds a NUL byte.
 */
function structuredCommand(command: string, args: unknown): string | undefined {
  // Without args, `{command}` is also the legacy shell-string form (`schemas.ts:166-176`); the
  // gate reads it as shell, which sees at least what an executable name would run.
  if (args === undefined) return command;
  if (!Array.isArray(args)) return undefined;
  const argv = args as unknown[];
  if (!argv.every((a): a is string => typeof a === "string")) return undefined;
  const words = [command, ...argv];
  if (words.some((w) => w.includes("\0"))) return undefined;
  return words.map(shQuote).join(" ");
}

/** The commands of one `run_commands` input, and whether some entry could not be read. */
interface ClineRead {
  commands: string[];
  unreadable: boolean;
}

/** One `run_commands` entry or input: a command string, a list, or an object holding them. */
function clineEntry(entry: unknown, out: ClineRead): ClineRead {
  if (typeof entry === "string") {
    if (entry.trim()) out.commands.push(entry);
  } else if (Array.isArray(entry)) {
    for (const item of entry) clineEntry(item, out);
  } else if (entry && typeof entry === "object") {
    clineObject(entry as Record<string, unknown>, out);
  }
  return out;
}

function clineObject(entry: Record<string, unknown>, out: ClineRead): void {
  const { command, args, commands, cmd } = entry;
  if (commands !== undefined) {
    clineEntry(commands, out);
  } else if (typeof command === "string" && command.trim()) {
    const line = structuredCommand(command, args);
    if (line === undefined) out.unreadable = true;
    else out.commands.push(line);
  } else if (typeof cmd === "string" && cmd.trim()) {
    out.commands.push(cmd);
  }
}

/**
 * A `preToolUse.parameters` value. Cline turns every non-string input value into JSON text
 * (`toStringRecord`, `apps/vscode/src/sdk/hooks-adapter.ts:28-38`; `mapParams`,
 * `sdk/packages/core/src/hooks/hook-file-hooks.ts:118-127`), so `commands` arrives as
 * `"[\"npm i x\"]"`. Text that does not parse as a JSON array or object is a command itself.
 */
function clineParam(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text.startsWith("[") && !text.startsWith("{")) return value;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

/** Read a Cline PreToolUse payload: undefined when it is not Cline's. */
function readCline(payload: unknown): ClineRead | undefined {
  const p = (payload ?? {}) as {
    tool_call?: { input?: unknown };
    preToolUse?: { toolName?: unknown; parameters?: unknown };
  };
  if (!p.preToolUse || typeof p.preToolUse !== "object") return undefined;
  const input = p.tool_call && typeof p.tool_call === "object" ? p.tool_call.input : undefined;
  // A bare string or list is a command only for the shell tool: `apply_patch` also takes a bare
  // string, and that is patch text.
  const shell = CLINE_SHELL_TOOLS.has(String(p.preToolUse.toolName));
  if (input !== undefined && (shell || (typeof input === "object" && !Array.isArray(input)))) {
    const raw = clineEntry(input, { commands: [], unreadable: false });
    if (raw.commands.length > 0 || raw.unreadable) return raw;
  }
  const params = p.preToolUse.parameters;
  const decoded: Record<string, unknown> = {};
  if (params && typeof params === "object") {
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      decoded[key] = clineParam(value);
    }
  }
  return clineEntry(decoded, { commands: [], unreadable: false });
}

/**
 * Every shell command of a Cline PreToolUse payload, in order. Cline runs `run_commands` with
 * `{commands: string[]}` (`schemas.ts:149-176` accepts more shapes), and each one must pass the
 * gate. The CLI payload also carries the raw input in `tool_call.input` (`hook-file-hooks.ts:858-866`),
 * which is read first. Returns undefined for a payload that is not Cline's.
 */
export function clineCommands(payload: unknown): string[] | undefined {
  return readCline(payload)?.commands;
}

/**
 * True when Cline asks to run its shell tool and kit cannot read every command from the payload:
 * no command at all (a bare string input, which the VS Code adapter turns into `{}`), or a
 * `{command, args}` entry whose argv cannot be written as shell words. The gate cannot tell what
 * would run, so it blocks.
 */
export function clineShellCallUnreadable(payload: unknown): boolean {
  const tool = (payload as { preToolUse?: { toolName?: unknown } } | null)?.preToolUse?.toolName;
  if (typeof tool !== "string" || !CLINE_SHELL_TOOLS.has(tool)) return false;
  const read = readCline(payload);
  return !read || read.unreadable || read.commands.length === 0;
}

/**
 * Extract the shell commands from an agent's PreToolUse-style hook payload,
 * across every wire shape kit's `gate-bash` handler supports:
 *   - Claude Code / Codex / Amazon Q / Gemini / Droid / Augment → `tool_input.command`
 *   - Cursor `beforeShellExecution`            → top-level `command`
 *   - Cline `PreToolUse` (`run_commands`)      → `tool_call.input.commands`, or
 *     `preToolUse.parameters.commands` as JSON text; every command (`clineCommands`)
 *   - Antigravity `run_command` hook          → `toolCall.args.CommandLine`
 *   - Sourcegraph Amp permissions delegate    → `arguments.command`
 * Tolerates array-form (`[bin, ...args]`) by joining on spaces. Returns [] when
 * the tool call carries no shell command (→ the gate allows it). Pure.
 */
export function extractCommandsFromHookPayload(payload: unknown): string[] {
  const p = (payload ?? {}) as { tool_input?: { command?: unknown } };
  if (p.tool_input?.command === undefined) {
    const cline = clineCommands(payload);
    if (cline !== undefined) return cline;
  }
  const raw = rawHookCommand(payload);
  const line =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === "string").join(" ")
        : "";
  return line ? [line] : [];
}

/** The one command field of a non-Cline hook payload, in the order the list above gives. */
function rawHookCommand(payload: unknown): unknown {
  const p = (payload ?? {}) as {
    tool_input?: { command?: unknown };
    command?: unknown;
    toolCall?: { args?: { CommandLine?: unknown } };
    arguments?: { command?: unknown };
  };
  return (
    p.tool_input?.command ??
    p.toolCall?.args?.CommandLine ??
    p.arguments?.command ??
    p.command ??
    toolArgsCommand(payload)
  );
}

/**
 * The shell command of a hook payload as one string; several commands (Cline's `run_commands`)
 * are joined by newlines, so a gate that reads one command still sees each of them. Pure.
 */
export function extractCommandFromHookPayload(payload: unknown): string {
  return extractCommandsFromHookPayload(payload).join("\n");
}
