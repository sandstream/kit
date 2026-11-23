import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";

export interface SupervisorRequest {
  parent: number;
  deadlineMs: number;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface SupervisorReceipt {
  proof: string;
  code: number | null;
  outcome: "exited" | "timed-out" | "interrupted" | "output-limit";
  stdout: string;
  stderr: string;
}

function collect(stream: Readable, limit: number, stop: () => void): () => string {
  const parts: Buffer[] = [];
  let total = 0;
  stream.on("data", (part: Buffer) => {
    total += part.length;
    if (total > limit) stop();
    else parts.push(part);
  });
  return () => Buffer.concat(parts).toString("utf8");
}

function closed(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve) => {
    child.once("error", () => {});
    child.once("close", (code, signal) => resolve([code, signal]));
  });
}

/** This trusted monitor lives in a separate process from candidate code. */
async function supervise(request: SupervisorRequest): Promise<SupervisorReceipt | undefined> {
  if (process.ppid !== request.parent) return undefined;
  const child = spawn("/usr/bin/sandbox-exec", request.args, {
    env: request.env,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  const stopped = closed(child);
  const proofPipe = child.stdio[3];
  if (!child.stdout || !child.stderr || !(proofPipe instanceof Readable)) {
    child.kill("SIGKILL");
    await stopped;
    return undefined;
  }
  let cause: SupervisorReceipt["outcome"] | undefined;
  const stop = (reason: SupervisorReceipt["outcome"]) => {
    cause ??= reason;
    child.kill("SIGKILL");
  };
  const limit = () => stop("output-limit");
  const stdout = collect(child.stdout, 1024 * 1024, limit);
  const stderr = collect(child.stderr, 1024 * 1024, limit);
  const proof = collect(proofPipe, 64, limit);
  const timeout = setTimeout(() => stop("timed-out"), request.deadlineMs);
  const checkParent = setInterval(() => {
    if (process.ppid !== request.parent) stop("interrupted");
  }, 50);
  const interrupt = () => stop("interrupted");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const [code, signal] = await stopped;
    return {
      code,
      proof: proof(),
      stdout: stdout(),
      stderr: stderr(),
      outcome: cause ?? (signal ? "interrupted" : "exited"),
    };
  } finally {
    clearTimeout(timeout);
    clearInterval(checkParent);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

const request = JSON.parse(process.argv[1]!) as SupervisorRequest;
const result = await supervise(request);
if (result) process.stdout.write(JSON.stringify(result));
