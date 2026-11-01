/** Refuse process failures that are not an intentional fixture exit. */
import type { ChildProcess, SpawnSyncReturns } from "node:child_process";

export function captureChildStderr(child: ChildProcess): () => string {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16_000);
  });
  return () => stderr;
}

export function requireChildExit(
  result: SpawnSyncReturns<string>,
  label: string,
): SpawnSyncReturns<string> {
  if (result.error || result.signal || result.status === null) {
    const detail = [
      result.error?.message ?? "",
      result.signal ? `signal: ${result.signal}` : "",
      `status: ${String(result.status)}`,
      result.stdout ? `stdout: ${result.stdout}` : "",
      result.stderr ? `stderr: ${result.stderr}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(`${label} did not exit normally\n${detail}`);
  }
  return result;
}
