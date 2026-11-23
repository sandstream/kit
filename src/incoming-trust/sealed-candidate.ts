import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReadOnlyMode } from "../read-only-mode.js";
import { sameIdentity } from "../utils/same-file.js";
import { secureDirStrict } from "../utils/secure-perms.js";
import type { IncomingPreflight } from "./retained-approval.js";
import {
  checkReadOnlyImage,
  ejectReadOnlyImage,
  mountReadOnlyImage,
} from "./sealed-image-macos.js";
import { captureIncomingSnapshot } from "./snapshot.js";
import { snapshotLimits } from "./snapshot-limits.js";
import { removeOwnedSnapshot } from "./snapshot-storage.js";

type SealedFailure = {
  verified: false;
  reason:
    | "read-only"
    | "sealed-platform-unsupported"
    | "sealed-input-unavailable"
    | "sealed-teardown-failed";
};

export type SealedIncomingPreflight =
  IncomingPreflight | { verified: true; inputs: "read-only-image" } | SealedFailure;

type MountedOperation<T> = (mount: string, assertPinned: () => void) => T;

function copyRetainedCandidate(source: string, workspace: string): string {
  const limits = snapshotLimits();
  return captureIncomingSnapshot(source, join(workspace, "source"), {
    maxEntries: limits.maxEntries + 2048,
    maxBytes: limits.maxBytes + 512 * 1024 * 1024,
    maxDepth: limits.maxDepth + 1,
    maxPathBytes: limits.maxPathBytes + "tree/".length,
    maxManifestBytes: limits.maxManifestBytes * 2,
  }).tree;
}

function checkMountedCandidate<T>(
  work: string,
  image: string,
  copy: string,
  use: MountedOperation<T>,
): T {
  const mount = join(work, "mounted");
  mkdirSync(mount, { mode: 0o700 });
  const unmounted = lstatSync(mount, { bigint: true });
  const volume = mountReadOnlyImage(image, copy, mount, work);
  const root = openSync(mount, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    // On macOS the open directory keeps an ordinary eject from replacing the mounted path.
    const mounted = fstatSync(root, { bigint: true });
    if (unmounted.dev === mounted.dev) throw new Error("Disk image has no distinct device");
    const assertPinned = () => {
      if (!sameIdentity(mounted, lstatSync(mount, { bigint: true })))
        throw new Error("Disk image mount changed");
      checkReadOnlyImage(mount, volume, work);
    };
    assertPinned();
    const result = use(mount, assertPinned);
    assertPinned();
    return result;
  } finally {
    closeSync(root);
  }
}

/** The verifier runs against a bounded copy on a read-only mount. The result outlives no mount. */
export function preflightSealedCandidate(
  source: string,
  verify: (path: string) => IncomingPreflight,
): SealedIncomingPreflight {
  if (isReadOnlyMode()) return { verified: false, reason: "read-only" };
  if (process.platform !== "darwin")
    return { verified: false, reason: "sealed-platform-unsupported" };
  const original = verify(source);
  if (!original.verified) return original;
  return withSealedCandidate(source, (mount) => {
    const checked = verify(mount);
    return checked.verified
      ? { verified: true as const, inputs: "read-only-image" as const }
      : checked;
  });
}

/** Keep the external read-only volume pinned for the synchronous host operation. */
export function withSealedCandidate<T>(
  source: string,
  use: MountedOperation<T>,
): T | SealedFailure {
  if (isReadOnlyMode()) return { verified: false, reason: "read-only" };
  if (process.platform !== "darwin")
    return { verified: false, reason: "sealed-platform-unsupported" };
  try {
    const work = mkdtempSync(join(realpathSync(tmpdir()), "kit-incoming-sealed-"));
    return verifyInWorkspace(work, source, use);
  } catch {
    return { verified: false, reason: "sealed-input-unavailable" };
  }
}

function verifyInWorkspace<T>(
  work: string,
  source: string,
  use: MountedOperation<T>,
): T | SealedFailure {
  const identity = lstatSync(work, { bigint: true });
  const image = join(work, "candidate.dmg");
  let result: T | SealedFailure;
  try {
    secureDirStrict(work);
    result = checkMountedCandidate(work, image, copyRetainedCandidate(source, work), use);
  } catch {
    result = { verified: false, reason: "sealed-input-unavailable" };
  }
  try {
    if (lstatSync(image, { throwIfNoEntry: false })) ejectReadOnlyImage(image, work);
    const mount = lstatSync(join(work, "mounted"), { bigint: true, throwIfNoEntry: false });
    if (mount && mount.dev !== identity.dev) throw new Error("Disk image mount remains");
    removeOwnedSnapshot(work, identity);
    if (lstatSync(work, { throwIfNoEntry: false })) throw new Error("Disk image workspace remains");
    return result;
  } catch {
    return { verified: false, reason: "sealed-teardown-failed" };
  }
}
