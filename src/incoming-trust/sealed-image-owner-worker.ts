import { existsSync, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { basename } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { ejectReadOnlyImage, mountReadOnlyImage } from "./sealed-image-macos.js";
import {
  imageOwnerPaths,
  ownedWorkspace,
  publishImageMessage,
  readImageMessage,
  type ImageCleanupStep,
  type ImageMountRequest,
  type ImageOwnerRequest,
} from "./sealed-image-owner.js";
import { readSnapshotBytes } from "./snapshot-io.js";
import { containsSnapshotPath, removeOwnedSnapshot } from "./snapshot-storage.js";

function busyImage(error: unknown): boolean {
  if (error instanceof Error && error.message === "Disk image is still attached") return true;
  return (
    !!error &&
    typeof error === "object" &&
    "stderr" in error &&
    /busy|dissented|could not be unmounted/i.test(String(error.stderr))
  );
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

async function cleanupFailureAt(
  request: ImageOwnerRequest,
  identity: BigIntStats,
  paths: ImagePaths,
): Promise<ImageCleanupStep | undefined> {
  let step: ImageCleanupStep = "verify-workspace";
  try {
    for (const delay of [0, 100, 200, 400, 800, 1600, 3200]) {
      if (delay) await pause(delay);
      step = "verify-workspace";
      if (!ownedWorkspace(request)) return;
      step = "detach-image";
      try {
        if (existsSync(paths.image)) ejectReadOnlyImage(paths.image, request.workspace);
      } catch (error) {
        if (!busyImage(error)) throw error;
        continue;
      }
      step = "inspect-mount";
      const mount = lstatSync(paths.mount, { bigint: true, throwIfNoEntry: false });
      // The attached image list can omit a volume that is still mounted.
      if (mount && mount.dev !== identity.dev) continue;
      step = "remove-workspace";
      removeOwnedSnapshot(request.workspace, identity);
      return ownedWorkspace(request) ? step : undefined;
    }
  } catch {
    return step;
  }
  return step;
}

async function ownImage(request: ImageOwnerRequest): Promise<void> {
  const identity = ownedWorkspace(request);
  if (!identity) return;
  const paths = imageOwnerPaths(request.workspace);
  assertClaim(request, paths);
  let released = false;
  const closeControl = () => {
    released = true;
  };
  process.stdin.once("end", closeControl).once("error", closeControl);
  process.stdin.resume();
  const finished = () => released || process.ppid !== request.parent;
  try {
    publishImageMessage(paths.ownerPid, String(process.pid));
    await mountAndHold(request.workspace, paths, finished);
  } catch {
    if (ownedWorkspace(request) && !finished()) publishImageMessage(paths.status, "mount-failed");
  } finally {
    try {
      const failure = await cleanupFailureAt(request, identity, paths);
      if (failure) {
        process.exitCode = 1;
        if (ownedWorkspace(request)) publishImageMessage(paths.status, `cleanup-failed:${failure}`);
      }
    } finally {
      process.stdin.destroy();
    }
  }
}

await ownImage(JSON.parse(process.argv[2]!) as ImageOwnerRequest);
