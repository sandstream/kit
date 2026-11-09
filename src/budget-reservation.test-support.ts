import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const source = import.meta.url.endsWith(".ts");
const loader = source ? ["--import", import.meta.resolve("tsx")] : [];
const cli = fileURLToPath(new URL(source ? "./cli.ts" : "./cli.js", import.meta.url));

/** Run one real process with fixture stores and always await its closure. */
export async function reservationNode(cwd: string, args: string[]) {
  const child = spawn(process.execPath, [...loader, ...args], {
    cwd,
    env: {
      ...process.env,
      CI: "true",
      NO_COLOR: "1",
      TSX_DISABLE_CACHE: "1",
      KIT_NON_INTERACTIVE: "1",
      KIT_NO_UPDATE_CHECK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await closed;
    assert.ifError(spawnError);
    return { code: child.exitCode, signal: child.signalCode, stdout, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}

export function reservationCli(cwd: string, args: string[]) {
  return reservationNode(cwd, [cli, ...args]);
}
