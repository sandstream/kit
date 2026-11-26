/**
 * Process and diagnostic helpers shared by the propagation adapters. The value is piped through
 * stdin, never argv, and every diagnostic is redacted against the values it could echo.
 */
import { spawn } from "node:child_process";
import { redactSecrets } from "./utils/redactSecrets.js";
import { resolvePinnedCli, VendorCliPinRefusal } from "./vendor-cli-pin.js";

export function safeDiagnostic(
  value: unknown,
  knownSecrets: readonly string[] = [],
  max = 300,
): string {
  const text = redactSecrets(value instanceof Error ? value.message : String(value), knownSecrets);
  return (text.split(/\r?\n/)[0] ?? "").slice(0, max);
}

/** Exit code reported for a CLI the vendor-CLI pin refused: it was never started. */
export const PIN_REFUSED_CODE = 126;

/**
 * Spawns a CLI with the value piped via stdin. Returns the exit code +
 * captured stderr for diagnostics. The value never appears in argv.
 *
 * The CLI is resolved behind the vendor-CLI pin (`resolvePinnedCli`): a pinned CLI that changed is
 * never started and the value never leaves kit; the result is `PIN_REFUSED_CODE` with the refusal
 * as its first stderr line.
 */
export async function spawnWithStdin(
  cmd: string,
  args: string[],
  stdinValue: string,
  sensitiveValues: readonly string[] = [],
): Promise<{ code: number; stderr: string }> {
  let bin: string;
  try {
    bin = await resolvePinnedCli(cmd);
  } catch (err) {
    if (!(err instanceof VendorCliPinRefusal)) throw err;
    return { code: PIN_REFUSED_CODE, stderr: err.message };
  }
  return spawnResolved(bin, args, stdinValue, sensitiveValues);
}

function spawnResolved(
  cmd: string,
  args: string[],
  stdinValue: string,
  sensitiveValues: readonly string[],
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
    // A CLI that exits before it reads stdin (bad argument, missing login) breaks the pipe. The
    // write then fails with EPIPE; the exit code and stderr from "close" are the real answer.
    child.stdin.on("error", () => undefined);
    child.stdin.write(stdinValue);
    child.stdin.end();
  });
}
