import fs from "node:fs";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface BootstrapRequest {
  entry: string;
  authority: string;
  output: string;
  runId: string;
  approvalDeadline: number;
}

const { entry, authority, output, runId, approvalDeadline } = JSON.parse(
  process.argv[1]!,
) as BootstrapRequest;

function denied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

function denyAuthorityAccess(flags: string): boolean {
  try {
    fs.closeSync(fs.openSync(authority, flags));
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
  const marker = join(output, ".kit-permission-" + runId);
  fs.writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
  fs.unlinkSync(marker);
  return true;
}

if (!(await verifyRestrictions()) || Date.now() >= approvalDeadline) process.exit(125);
fs.writeSync(3, runId);
fs.closeSync(3);
process.argv = [process.execPath, entry];
await import(pathToFileURL(entry).href);
