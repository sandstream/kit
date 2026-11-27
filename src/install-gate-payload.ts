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
 * One `run_commands` entry: a command string, or `{command, args}` that Cline runs without a
 * shell (`StructuredCommandInputSchema`, `sdk/packages/core/src/extensions/tools/schemas.ts:133-142`).
 */
function clineEntry(entry: unknown): string[] {
  if (typeof entry === "string") return entry.trim() ? [entry] : [];
  if (Array.isArray(entry)) return entry.flatMap(clineEntry);
  if (!entry || typeof entry !== "object") return [];
  const { command, args, commands, cmd } = entry as Record<string, unknown>;
  if (commands !== undefined) return clineEntry(commands);
  if (typeof command === "string" && command.trim()) {
    const argv = Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [];
    return [[command, ...argv].join(" ")];
  }
  return typeof cmd === "string" && cmd.trim() ? [cmd] : [];
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

/**
 * Every shell command of a Cline PreToolUse payload, in order. Cline runs `run_commands` with
 * `{commands: string[]}` (`schemas.ts:149-176` accepts more shapes), and each one must pass the
 * gate. The CLI payload also carries the raw input in `tool_call.input` (`hook-file-hooks.ts:858-866`),
 * which is read first. Returns undefined for a payload that is not Cline's.
 */
export function clineCommands(payload: unknown): string[] | undefined {
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
    const raw = clineEntry(input);
    if (raw.length > 0) return raw;
  }
  const params = p.preToolUse.parameters;
  if (!params || typeof params !== "object") return [];
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    decoded[key] = clineParam(value);
  }
  return clineEntry(decoded);
}

/**
 * True when Cline asks to run its shell tool but kit can read no command from the payload, for
 * example a bare string input, which the VS Code adapter turns into `{}`. The gate cannot tell
 * what would run, so it blocks.
 */
export function clineShellCallUnreadable(payload: unknown): boolean {
  const tool = (payload as { preToolUse?: { toolName?: unknown } } | null)?.preToolUse?.toolName;
  if (typeof tool !== "string" || !CLINE_SHELL_TOOLS.has(tool)) return false;
  return (clineCommands(payload) ?? []).length === 0;
}
