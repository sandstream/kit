/** Isolated subprocess launcher for source and compiled runner tests. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fixtureEnvironment } from "./monkey-test-runner.test-support.js";

const source = import.meta.url.endsWith(".ts");
const commandEntry = new URL(`./commands/monkey-test.${source ? "ts" : "js"}`, import.meta.url);
const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));

export function runnerEntry(): string {
  return new URL(`./monkey-test-runner.${source ? "ts" : "js"}`, import.meta.url).href;
}

export function spawnMonkey(root: string, args: string[]) {
  const script = `const { cmdMonkeyTest } = await import(${JSON.stringify(commandEntry.href)});
process.argv = [process.execPath, "kit", ...process.argv.slice(1)];
process.exitCode = await cmdMonkeyTest() ? 0 : 1;`;
  return spawnRunnerScript(root, script, [
    "monkey-test",
    "run",
    "--skip-security",
    "--expected",
    "Synthetic runner regression fixture",
    ...args,
  ]);
}

export function spawnRunnerScript(root: string, script: string, args: string[] = []) {
  const child = spawn(
    process.execPath,
    [...(source ? ["--import", loader] : []), "--input-type=module", "-e", script, ...args],
    { cwd: root, env: fixtureEnvironment(join(root, "home")), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    },
  );
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  return { child, exited, closed, output: () => ({ stdout, stderr }) };
}

export function terminateRunnerTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    execFile(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { timeout: 5_000, windowsHide: true },
      (error) => {
        if (error) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The runner may have exited while taskkill was finishing.
          }
        }
      },
    );
    return;
  }
  child.kill("SIGKILL");
}

export async function runMonkey(root: string, args: string[]) {
  const run = spawnMonkey(root, args);
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      terminateRunnerTree(run.child);
    },
    process.platform === "win32" ? 20_000 : 8_000,
  );
  try {
    const exit = await run.exited;
    await run.closed;
    if (timedOut) throw new Error("isolated monkey runner fixture timed out");
    return { ...exit, ...run.output() };
  } finally {
    clearTimeout(timer);
  }
}

export async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
