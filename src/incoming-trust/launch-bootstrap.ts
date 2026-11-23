import fs from "node:fs";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const [entry, authority, output, runId, approvalDeadline, runDeadline, parent, watchdog, timeout] =
  process.argv.slice(1) as string[];

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

function denyAuthorityAccess(flags: string): boolean {
  try {
    fs.closeSync(fs.openSync(authority!, flags));
  } catch (error) {
    return denied(error);
  }
  return false;
}

function denyConnection(): Promise<boolean> {
  return new Promise((done) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 1 });
    socket.once("error", (error) => done(denied(error)));
    socket.once("connect", () => {
      socket.destroy();
      done(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      done(false);
    });
  });
}

async function verifyRestrictions(): Promise<boolean> {
  if (
    Object.keys(process.env).some(
      (key) => !["LANG", "PATH", "__CF_USER_TEXT_ENCODING"].includes(key),
    )
  )
    return false;
  if (!denyAuthorityAccess("r") || !denyAuthorityAccess("r+")) return false;
  if (!denied(spawnSync(process.execPath, ["--version"], { timeout: 500 }).error)) return false;
  if (!(await denyConnection())) return false;
  const marker = join(output!, ".kit-permission-" + runId);
  fs.writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
  fs.unlinkSync(marker);
  return true;
}

async function armWatchdog(): Promise<boolean> {
  if (process.ppid !== Number(parent)) return false;
  const delay = Math.min(Number(timeout), Number(runDeadline) - Date.now());
  if (!Number.isSafeInteger(delay) || delay <= 0) return false;
  const url = new URL("data:text/javascript," + encodeURIComponent(watchdog!));
  const worker = new Worker(url, {
    execArgv: [],
    workerData: { parent: Number(parent), delay },
  });
  const [status] = await once(worker, "message");
  worker.unref();
  return status === "ready" && process.ppid === Number(parent);
}

if (
  !(await verifyRestrictions()) ||
  !(await armWatchdog()) ||
  Date.now() >= Number(approvalDeadline)
)
  process.exit(125);
fs.writeSync(3, runId!);
fs.closeSync(3);
process.argv = [process.execPath, entry!];
await import(pathToFileURL(entry!).href);
