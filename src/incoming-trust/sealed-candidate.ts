import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isReadOnlyMode } from "../read-only-mode.js";
import { sameIdentity } from "../utils/same-file.js";
import { secureDirStrict } from "../utils/secure-perms.js";
import type { IncomingPreflight } from "./retained-approval.js";
import { checkReadOnlyImage } from "./sealed-image-macos.js";
import { imageOwnerPaths, startImageOwner } from "./sealed-image-owner.js";
import { captureIncomingSnapshot } from "./snapshot.js";
import { snapshotLimits } from "./snapshot-limits.js";
import { copySnapshotFile, readSnapshotFile } from "./snapshot-io.js";
import { removeOwnedSnapshot } from "./snapshot-storage.js";
import { snapshotDigest } from "./snapshot-format.js";
import {
  materializeRunTree,
  NpmExpectationMismatch,
  verifyMaterializedRunTree,
  type ApprovedRunTree,
} from "./runtime-tree.js";

type SealedFailure = {
  verified: false;
  reason:
    | "read-only"
    | "sealed-platform-unsupported"
    | "sealed-input-unavailable"
    | "sealed-run-tree-mismatch"
    | "run-npm-expectations-mismatch"
    | "sealed-teardown-failed";
};

export type SealedIncomingPreflight =
  IncomingPreflight | { verified: true; inputs: "read-only-image" } | SealedFailure;

type MountedOperation<T> = (mount: string, assertPinned: () => void) => T;

interface ImageOwnerHost {
  executable: string;
  assertStableBuild: () => void;
}

interface ImageOptions {
  executable?: boolean;
  host?: ImageOwnerHost;
  assertStableBuild?: () => void;
}

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
  root: { mount: string; unmounted: BigIntStats; volume: string },
  assertOwner: () => void,
  use: MountedOperation<T>,
): T {
  const { mount, unmounted, volume } = root;
  const handle = openSync(mount, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    // On macOS the open directory keeps an ordinary eject from replacing the mounted path.
    const mounted = fstatSync(handle, { bigint: true });
    if (unmounted.dev === mounted.dev) throw new Error("Disk image has no distinct device");
    const assertPinned = () => {
      if (!sameIdentity(mounted, lstatSync(mount, { bigint: true })))
        throw new Error("Disk image mount changed");
      checkReadOnlyImage(mount, volume, work);
      assertOwner();
    };
    assertPinned();
    const result = use(mount, assertPinned);
    assertPinned();
    return result;
  } finally {
    closeSync(handle);
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
  host?: ImageOwnerHost,
): T | SealedFailure {
  return withPinnedImage((work) => copyRetainedCandidate(source, work), use, { host });
}

/** The signed input mount remains pinned while this independently checked tree is used. */
export function withSealedRunTree<T>(
  approved: ApprovedRunTree,
  use: (tree: string, digest: string, assertPinned?: () => void) => T,
  host: ImageOwnerHost,
): T | SealedFailure {
  if (approved.inventory.artifacts.length === 0)
    return use(join(approved.mounted, "tree"), snapshotDigest(approved.manifest));
  let expected = "";
  return withPinnedImage(
    (workspace) => {
      const prepared = materializeRunTree(approved, workspace);
      expected = prepared.manifest;
      return prepared.tree;
    },
    (mounted, assertPinned) => {
      if (!verifyMaterializedRunTree(mounted, expected))
        return { verified: false, reason: "sealed-run-tree-mismatch" } as const;
      return use(mounted, snapshotDigest(expected), assertPinned);
    },
    { host },
  );
}

/** Execute the verified runtime from its own immutable volume. The candidate stays noexec. */
export function withSealedRuntime<T>(
  runtime: string,
  digest: string,
  use: (mount: string, assertPinned: () => void, ownerExecutable: string) => T,
  assertStableBuild?: () => void,
): T | SealedFailure {
  const limit = 192 * 1024 * 1024;
  return withPinnedImage(
    (workspace) => {
      const source = join(workspace, "runtime");
      mkdirSync(source, { mode: 0o700 });
      const copy = join(source, "node");
      const original = lstatSync(runtime, { bigint: true });
      if (copySnapshotFile(runtime, copy, original, limit).sha256 !== digest)
        throw new Error("Runtime digest changed");
      return source;
    },
    (mount, assertPinned) => {
      const entry = join(mount, "node");
      if (readSnapshotFile(entry, lstatSync(entry, { bigint: true }), limit).sha256 !== digest)
        throw new Error("Mounted runtime digest changed");
      return use(entry, assertPinned, join(dirname(mount), "runtime", "node"));
    },
    { executable: true, assertStableBuild },
  );
}

function withPinnedImage<T>(
  materialize: (work: string) => string,
  use: MountedOperation<T>,
  options: ImageOptions,
): T | SealedFailure {
  if (isReadOnlyMode()) return { verified: false, reason: "read-only" };
  if (process.platform !== "darwin")
    return { verified: false, reason: "sealed-platform-unsupported" };
  try {
    const work = mkdtempSync(join(realpathSync(tmpdir()), "kit-incoming-sealed-"));
    return verifyInWorkspace(work, materialize, use, options);
  } catch {
    return { verified: false, reason: "sealed-input-unavailable" };
  }
}

function verifyInWorkspace<T>(
  work: string,
  materialize: (work: string) => string,
  use: MountedOperation<T>,
  options: ImageOptions,
): T | SealedFailure {
  const identity = lstatSync(work, { bigint: true });
  let owner: ReturnType<typeof startImageOwner> | undefined;
  let result: T | SealedFailure;
  try {
    secureDirStrict(work);
    const runtimeSource = options.executable ? materialize(work) : undefined;
    options.host?.assertStableBuild();
    options.assertStableBuild?.();
    const hostExecutable = runtimeSource
      ? join(runtimeSource, "node")
      : (options.host?.executable ?? process.execPath);
    owner = startImageOwner(work, identity, hostExecutable);
    owner.awaitReady();
    const source = runtimeSource ?? materialize(work);
    const { mount } = imageOwnerPaths(work);
    mkdirSync(mount, { mode: 0o700 });
    const unmounted = lstatSync(mount, { bigint: true });
    const volume = owner.mount({ source, executable: options.executable ?? false });
    result = checkMountedCandidate(work, { mount, unmounted, volume }, owner.assertRunning, use);
  } catch (error) {
    result = {
      verified: false,
      reason:
        error instanceof NpmExpectationMismatch
          ? "run-npm-expectations-mismatch"
          : "sealed-input-unavailable",
    };
  }
  try {
    if (owner) owner.release();
    else removeOwnedSnapshot(work, identity);
    if (lstatSync(work, { throwIfNoEntry: false })) throw new Error("Disk image workspace remains");
    return result;
  } catch {
    return { verified: false, reason: "sealed-teardown-failed" };
  }
}
