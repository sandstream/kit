import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { processTreeRunning } from "./monkey-test-process.js";

export type EvalResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "timeout" | "exited" | "error"; message: string };

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * The app under test: one debug build, started by the configured command, driven through
 * its eval hook. The hook contract (see docs/MONKEY_TEST.md) is two files in the hook
 * folder: the driver renames a function body into `cmd.js`; the app deletes it, runs the
 * body as an async function in its main window, and writes the string result to
 * `out.txt`. Every body is wrapped with a fresh nonce, so a late answer to an earlier
 * command is never read as the answer to this one.
 */
export class DesktopApp {
  private child: ChildProcess | undefined;
  private log = "";
  private scanned = 0;

  constructor(
    private readonly opts: {
      command: string;
      cwd: string;
      env: NodeJS.ProcessEnv;
      hookDir: string;
      logPath: string;
    },
  ) {}

  start(): void {
    const child = spawn(this.opts.command, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      this.log += text;
      appendFileSync(this.opts.logPath, text);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => onData(Buffer.from(`kit: start failed: ${error.message}\n`)));
    this.child = child;
  }

  running(): boolean {
    return this.child !== undefined && processTreeRunning(this.child);
  }

  private signal(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  }

  /** Waits up to `ms` for the whole process group to exit. */
  async waitExit(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!this.running()) return true;
      await sleep(25);
    }
    return !this.running();
  }

  /** Sends `signal`, waits `graceMs`, then SIGKILL. True when nothing of the app is left. */
  async stop(signal: "SIGTERM" | "SIGKILL", graceMs: number): Promise<boolean> {
    if (!this.running()) return true;
    this.signal(signal);
    if (await this.waitExit(graceMs)) return true;
    this.signal("SIGKILL");
    return this.waitExit(2_000);
  }

  /** Log text written since the previous call. */
  newLog(): string {
    const text = this.log.slice(this.scanned);
    this.scanned = this.log.length;
    return text;
  }

  async eval(body: string, timeoutMs: number): Promise<EvalResult> {
    const nonce = `kit-${randomUUID()}:`;
    const wrapped = [
      "try {",
      `  const __kitValue = await (async () => {\n${body}\n})();`,
      `  return ${JSON.stringify(nonce)} + JSON.stringify({ value: __kitValue === undefined ? null : __kitValue });`,
      "} catch (error) {",
      `  return ${JSON.stringify(nonce)} + JSON.stringify({ error: String((error && error.stack) || error) });`,
      "}",
    ].join("\n");
    const out = join(this.opts.hookDir, "out.txt");
    rmSync(out, { force: true });
    writeFileSync(join(this.opts.hookDir, "cmd.tmp"), wrapped);
    renameSync(join(this.opts.hookDir, "cmd.tmp"), join(this.opts.hookDir, "cmd.js"));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const answer = this.readAnswer(out, nonce);
      if (answer) return answer;
      if (!this.running()) return { ok: false, reason: "exited", message: "the app exited" };
      await sleep(25);
    }
    rmSync(join(this.opts.hookDir, "cmd.js"), { force: true });
    return { ok: false, reason: "timeout", message: `no answer within ${timeoutMs} ms` };
  }

  private readAnswer(out: string, nonce: string): EvalResult | null {
    if (!existsSync(out)) return null;
    let text: string;
    try {
      text = readFileSync(out, "utf8");
    } catch {
      return null;
    }
    if (text.startsWith("ERR")) return { ok: false, reason: "error", message: text };
    if (!text.startsWith(nonce)) {
      rmSync(out, { force: true });
      return null;
    }
    try {
      const parsed = JSON.parse(text.slice(nonce.length)) as { value?: unknown; error?: string };
      if (parsed.error !== undefined) return { ok: false, reason: "error", message: parsed.error };
      return { ok: true, value: parsed.value };
    } catch (error) {
      return { ok: false, reason: "error", message: `unreadable answer: ${String(error)}` };
    }
  }
}
