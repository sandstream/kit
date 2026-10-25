/**
 * Process and diagnostic helpers shared by the propagation adapters. The value is piped through
 * stdin, never argv, and every diagnostic is redacted against the values it could echo.
 */
import { spawn } from "node:child_process";
import { redactSecrets } from "./utils/redactSecrets.js";

export function safeDiagnostic(
  value: unknown,
  knownSecrets: readonly string[] = [],
  max = 300,
): string {
  const text = redactSecrets(value instanceof Error ? value.message : String(value), knownSecrets);
  return (text.split(/\r?\n/)[0] ?? "").slice(0, max);
}

/**
 * Spawns a CLI with the value piped via stdin. Returns the exit code +
 * captured stderr for diagnostics. The value never appears in argv.
 */
export async function spawnWithStdin(
  cmd: string,
  args: string[],
  stdinValue: string,
  sensitiveValues: readonly string[] = [],
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const knownSecrets = [stdinValue, ...sensitiveValues];
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      resolve({ code: 127, stderr: safeDiagnostic(err, knownSecrets) });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stderr: redactSecrets(stderr, knownSecrets) });
    });
    child.stdin.write(stdinValue);
    child.stdin.end();
  });
}
