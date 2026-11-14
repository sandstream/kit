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
