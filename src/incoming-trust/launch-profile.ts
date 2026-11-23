export const SEATBELT = "/usr/bin/sandbox-exec";
export const SEATBELT_SYSTEM_PROFILE = "/System/Library/Sandbox/Profiles/system.sb";

export const RUN_ENV = { LANG: "C", PATH: "/usr/bin:/bin" } as const;

export const PROFILE_RULES = [
  "(version 1)",
  "(deny default)",
  '(import "system.sb")',
  '(allow process-exec (literal (param "KIT_RUNTIME")))',
  "(deny process-fork network* signal mach-lookup mach-register)",
  "(deny system-socket ipc-posix* iokit-open* user-preference-read user-preference-write sysctl-write)",
  "(allow sysctl-read)",
  '(allow file-read* (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") (literal (param "KIT_RUNTIME")) (subpath (param "KIT_INPUT")) (subpath (param "KIT_OUTPUT")))',
  '(deny file-read-data (require-not (require-any (literal "/") (subpath "/usr/lib") (subpath "/System/Library") (literal "/dev/null") (literal (param "KIT_RUNTIME")) (subpath (param "KIT_INPUT")) (subpath (param "KIT_OUTPUT")))))',
  '(allow file-write* (subpath (param "KIT_OUTPUT")))',
  '(deny file-write* (require-not (subpath (param "KIT_OUTPUT"))))',
] as const;

/** This loader runs under the host policy before importing any candidate code. */
export const BOOTSTRAP = String.raw`
import fs from "node:fs";
import net from "node:net";
import {spawnSync} from "node:child_process";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const [entry, authority, output, runId, deadline] = process.argv.slice(1);
const denied = (error) => error?.code === "EPERM" || error?.code === "EACCES";
const refuse = () => process.exit(125);

function denyAuthorityAccess(flags) {
  try {
    fs.closeSync(fs.openSync(authority, flags));
  } catch (error) {
    return denied(error);
  }
  return false;
}

function denyConnection() {
  return new Promise((done) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 1 });
    socket.once("error", (error) => done(denied(error)));
    socket.once("connect", () => { socket.destroy(); done(false); });
    socket.setTimeout(500, () => { socket.destroy(); done(false); });
  });
}

if (Object.keys(process.env).some((key) =>
  !["LANG", "PATH", "__CF_USER_TEXT_ENCODING"].includes(key))) refuse();
if (!denyAuthorityAccess("r") || !denyAuthorityAccess("r+")) refuse();
if (!denied(spawnSync(process.execPath, ["--version"], { timeout: 500 }).error)) refuse();
if (!(await denyConnection())) refuse();
const marker = join(output, ".kit-permission-" + runId);
fs.writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
fs.unlinkSync(marker);
if (Date.now() >= Number(deadline)) refuse();
fs.writeSync(3, runId);
fs.closeSync(3);
process.argv = [process.execPath, entry];
await import(pathToFileURL(entry).href);
`;
