import { existsSync, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { basename } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { ejectReadOnlyImage, mountReadOnlyImage } from "./sealed-image-macos.js";
import {
  imageOwnerPaths,
  ownedWorkspace,
  publishImageMessage,
  readImageMessage,
  type ImageMountRequest,
  type ImageOwnerRequest,
} from "./sealed-image-owner.js";
import { readSnapshotBytes } from "./snapshot-io.js";
import { containsSnapshotPath, removeOwnedSnapshot } from "./snapshot-storage.js";

function busyImage(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("stderr" in error)) return false;
  return /busy|dissented|could not be unmounted/i.test(String(error.stderr));
}

async function releaseImage(image: string, workspace: string): Promise<void> {
  for (const delay of [100, 200, 400, 800, 1600, 3200]) {
    try {
      ejectReadOnlyImage(image, workspace);
      return;
    } catch (error) {
      if (!busyImage(error)) throw error;
      await pause(delay);
    }
  }
  ejectReadOnlyImage(image, workspace);
}

async function waitForMountRequest(path: string, finished: () => boolean) {
  while (!finished()) {
    const message = readImageMessage(path);
    if (message !== undefined) return JSON.parse(message) as ImageMountRequest;
    await pause(50);
  }
  return undefined;
}

type ImagePaths = ReturnType<typeof imageOwnerPaths>;

function assertClaim(request: ImageOwnerRequest, paths: ImagePaths): void {
  const { workspace } = request;
  if (
    realpathSync(workspace) !== workspace ||
    !/^kit-incoming-sealed-[a-zA-Z0-9]+$/.test(basename(workspace)) ||
    !/^[0-9a-f]{64}$/.test(request.claim) ||
    readSnapshotBytes(paths.claim, lstatSync(paths.claim, { bigint: true }), 64).toString(
      "utf8",
    ) !== request.claim
  )
    throw new Error("Disk image owner has no workspace claim");
}

async function mountAndHold(workspace: string, paths: ImagePaths, finished: () => boolean) {
  const mount = await waitForMountRequest(paths.request, finished);
  if (!mount || finished()) return;
  const { source, executable } = mount;
  if (
    source === workspace ||
    realpathSync(source) !== source ||
    !containsSnapshotPath(workspace, source) ||
    !lstatSync(source).isDirectory()
  )
    throw new Error("Invalid disk image source");
  publishImageMessage(paths.status, "attaching");
  const volume = mountReadOnlyImage(paths.image, source, paths.mount, workspace, executable);
  if (!finished()) publishImageMessage(paths.status, volume);
  while (!finished()) await pause(50);
}

async function cleanOwnedImage(
  request: ImageOwnerRequest,
  identity: BigIntStats,
  paths: ImagePaths,
) {
  if (!ownedWorkspace(request)) return;
  if (existsSync(paths.image)) await releaseImage(paths.image, request.workspace);
  const mount = lstatSync(paths.mount, { bigint: true, throwIfNoEntry: false });
  if (mount && mount.dev !== identity.dev) throw new Error("Disk image mount remains");
  removeOwnedSnapshot(request.workspace, identity);
  if (ownedWorkspace(request)) throw new Error("Disk image workspace remains");
}

async function ownImage(request: ImageOwnerRequest): Promise<void> {
  const identity = ownedWorkspace(request);
  if (!identity) return;
  const paths = imageOwnerPaths(request.workspace);
  assertClaim(request, paths);
  const finished = () => process.ppid !== request.parent || existsSync(paths.release);
  try {
    publishImageMessage(paths.ownerPid, String(process.pid));
    await mountAndHold(request.workspace, paths, finished);
  } catch {
    if (ownedWorkspace(request) && !finished()) publishImageMessage(paths.status, "mount-failed");
  } finally {
    try {
      await cleanOwnedImage(request, identity, paths);
    } catch {
      if (ownedWorkspace(request)) publishImageMessage(paths.status, "cleanup-failed");
      process.exitCode = 1;
    }
  }
}

await ownImage(JSON.parse(process.argv[2]!) as ImageOwnerRequest);
