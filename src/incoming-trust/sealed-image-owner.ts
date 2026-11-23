import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ImageOwnerRequest {
  workspace: string;
  claim: string;
  device: string;
  inode: string;
  parent: number;
}

export type ImageMountRequest = { source: string; executable: boolean };

export function imageOwnerPaths(workspace: string) {
  return {
    claim: join(workspace, "image-claim"),
    image: join(workspace, "candidate.dmg"),
    mount: join(workspace, "mounted"),
    ownerPid: join(workspace, "image-owner-pid"),
    status: join(workspace, "image-status"),
    request: join(workspace, "image-request"),
    release: join(workspace, "image-release"),
  };
}

export function ownedWorkspace(request: ImageOwnerRequest): BigIntStats | undefined {
  const info = lstatSync(request.workspace, { bigint: true, throwIfNoEntry: false });
  if (
    info &&
    (!info.isDirectory() ||
      info.ino.toString() !== request.inode ||
      info.dev.toString() !== request.device)
  )
    throw new Error("Disk image workspace changed");
  return info;
}

function childRunning(pid: number): boolean {
  try {
    const answer = execFileSync("/bin/ps", ["-o", "ppid=,state=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { LC_ALL: "C" },
      timeout: 2000,
    });
    const [parent, state] = answer.trim().split(/\s+/);
    return Number(parent) === process.pid && !!state && !state.startsWith("Z");
  } catch {
    return false;
  }
}

function waitForOwner<T>(pid: number, read: () => T | undefined): T {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const expires = performance.now() + 120_000;
  for (;;) {
    for (let attempts = 0; attempts < 5; attempts++) {
      const value = read();
      if (value !== undefined) return value;
      Atomics.wait(wait, 0, 0, 50);
    }
    if (performance.now() >= expires || !childRunning(pid)) {
      const last = read();
      if (last !== undefined) return last;
      throw new Error("Disk image owner unavailable");
    }
  }
}

export function readImageMessage(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

export function publishImageMessage(path: string, value: string): void {
  const temporary = path + ".tmp";
  writeFileSync(temporary, value, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

/** The child owns every native operation for this workspace, including recovery after Kit exits. */
export function startImageOwner(workspace: string, identity: BigIntStats, hostExecutable: string) {
  const request: ImageOwnerRequest = {
    workspace,
    claim: randomBytes(32).toString("hex"),
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    parent: process.pid,
  };
  const paths = imageOwnerPaths(workspace);
  writeFileSync(paths.claim, request.claim, { flag: "wx", mode: 0o600 });
  const worker = fileURLToPath(new URL("./sealed-image-owner-worker.js", import.meta.url));
  const child = spawn(hostExecutable, [worker, JSON.stringify(request)], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdio: "ignore",
    detached: true,
  });
  child.on("error", () => {});
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("Could not start disk image owner");
  return {
    awaitReady: () =>
      waitForOwner(pid, () => {
        const recorded = readImageMessage(paths.ownerPid);
        if (recorded === undefined) return undefined;
        if (recorded !== String(pid)) throw new Error("Disk image owner identity changed");
        return true;
      }),
    mount: (mount: ImageMountRequest) => {
      publishImageMessage(paths.request, JSON.stringify(mount));
      return waitForOwner(pid, () => {
        if (!ownedWorkspace(request)) throw new Error("Disk image owner could not mount image");
        const volume = readImageMessage(paths.status);
        if (volume === undefined || volume === "attaching") return undefined;
        if (!/^disk\d+s\d+$/.test(volume)) throw new Error("Disk image owner refused mount");
        return volume;
      });
    },
    assertRunning: () => {
      if (!childRunning(pid)) throw new Error("Disk image owner stopped");
    },
    release: () => {
      if (!ownedWorkspace(request)) return;
      try {
        writeFileSync(paths.release, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (ownedWorkspace(request)) throw error;
        return;
      }
      waitForOwner(pid, () => {
        if (!ownedWorkspace(request)) return true;
        if (readImageMessage(paths.status) === "cleanup-failed")
          throw new Error("Disk image cleanup failed");
        return undefined;
      });
    },
  };
}
