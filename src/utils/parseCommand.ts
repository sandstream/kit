/**
 * Parses a string from .kit.toml service config (login/check command).
 *
 * Adapters sometimes provide `#`-prefixed values as documentation when there
 * is no CLI to invoke (e.g. `# resend — no CLI login; set RESEND_API_KEY`).
 * Without this guard those strings get exec()'d and spawn fails with ENOENT.
 */
export type ParsedCommand =
  | { kind: "informational"; message: string }
  | { kind: "executable"; cmd: string; args: string[] };

export function parseCommand(command: string): ParsedCommand {
  const trimmed = command.trim();
  if (trimmed.startsWith("#")) {
    return {
      kind: "informational",
      message: trimmed.replace(/^#\s*/, ""),
    };
  }
  const parts = trimmed.split(/\s+/);
  const [cmd, ...args] = parts;
  return { kind: "executable", cmd, args };
}
