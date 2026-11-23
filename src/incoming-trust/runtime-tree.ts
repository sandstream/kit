import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { secureDirStrict, secureFileStrict } from "../utils/secure-perms.js";
import { inspectCandidateArchives } from "./candidate-artifacts.js";
import { readRetainedNpmInventory } from "./candidate-flow.js";
import { npmArchivePathKey, type NpmArchiveEntry } from "./npm-artifact-archive.js";
import { packageName } from "./npm-lock-read.js";
import { relativePath } from "./npm-lock-workspaces.js";
import type { NpmLockInventory } from "./npm-lock.js";
import { snapshotManifest, snapshotDigest, type IncomingSnapshotEntry } from "./snapshot-format.js";
import { readSnapshotManifest } from "./snapshot-io.js";
import { snapshotLimits } from "./snapshot-limits.js";
import { captureTree } from "./snapshot-tree.js";
import { captureIncomingSnapshot } from "./snapshot.js";

export const RUNTIME_TREE_RECIPE = "locked-npm-regular-files-v1";

export interface ApprovedRunTree {
  mounted: string;
  inventory: NpmLockInventory;
  manifest: string;
  entries: IncomingSnapshotEntry[];
}

export interface MaterializedRunTree {
  tree: string;
  manifest: string;
}

function unsupportedRuntimePath(path: string): boolean {
  const folded = npmArchivePathKey(path);
  return folded.split("/").includes("node_modules") || folded.endsWith(".node");
}

/** The caller holds and has verified the signed retained image. */
export function readApprovedRunTree(mounted: string): ApprovedRunTree | undefined {
  const manifest = readSnapshotManifest(
    join(mounted, "manifest.json"),
    snapshotLimits().maxManifestBytes,
  );
  const { entries } = JSON.parse(manifest) as { entries: IncomingSnapshotEntry[] };
  if (entries.some(({ path }) => unsupportedRuntimePath(path))) return undefined;
  const inventory = readRetainedNpmInventory(join(mounted, "tree"));
  if (typeof inventory === "string" || !supportedLayout(inventory)) return undefined;
  return { mounted, inventory, manifest, entries };
}

function slotParents(path: string): string[] | undefined {
  const parts = path.split("/");
  const parents: string[] = [];
  let index = 0;
  while (index < parts.length) {
    if (parts[index++] !== "node_modules") return undefined;
    const first = parts[index++];
    if (!first) return undefined;
    const name = first.startsWith("@") ? first + "/" + (parts[index++] ?? "") : first;
    if (!packageName(name)) return undefined;
    if (index < parts.length) parents.push(parts.slice(0, index).join("/"));
  }
  return parents;
}

function supportedLayout(inventory: NpmLockInventory): boolean {
  if (inventory.packages.length !== inventory.artifacts.length + 1) return false;
  const slots = new Set(inventory.artifacts.map(({ packagePath }) => packagePath));
  if (slots.size !== inventory.artifacts.length) return false;
  return [...slots].every((slot) => slotParents(slot)?.every((parent) => slots.has(parent)));
}

type TreeDirectory = Extract<IncomingSnapshotEntry, { kind: "directory" }>;
type TreeFile = Extract<IncomingSnapshotEntry, { kind: "file" }>;

class RuntimeTreeWriter {
  private readonly limits = snapshotLimits();
  private readonly directoriesAndFiles = new Map<string, IncomingSnapshotEntry>();
  private size = 0;
  private manifestBytes = Buffer.byteLength(snapshotManifest([], this.limits.maxManifestBytes));

  constructor(
    private readonly tree: string,
    approved: readonly IncomingSnapshotEntry[],
  ) {
    for (const item of approved) this.register(item);
  }

  private register(item: IncomingSnapshotEntry): void {
    const key = npmArchivePathKey(item.path);
    const depth = item.path ? item.path.split("/").length : 0;
    const bytes = item.kind === "file" ? item.size : 0;
    const manifestBytes =
      Buffer.byteLength(JSON.stringify(item)) + (this.directoriesAndFiles.size ? 1 : 0);
    if (
      depth > this.limits.maxDepth ||
      Buffer.byteLength(item.path) > this.limits.maxPathBytes ||
      this.directoriesAndFiles.size >= this.limits.maxEntries ||
      this.size + bytes > this.limits.maxBytes ||
      this.manifestBytes + manifestBytes > this.limits.maxManifestBytes
    )
      throw new Error("Incoming runtime tree limit");
    if (this.directoriesAndFiles.has(key)) throw new Error("Incoming runtime path collides");
    this.directoriesAndFiles.set(key, item);
    this.size += bytes;
    this.manifestBytes += manifestBytes;
  }

  private ensureDirectory(relative: string): void {
    const known = this.directoriesAndFiles.get(npmArchivePathKey(relative));
    if (known?.kind === "directory" && known.path === relative) return;
    const item: TreeDirectory = { path: relative, kind: "directory" };
    this.register(item);
    const path = join(this.tree, relative);
    this.assertParent(path);
    mkdirSync(path, { mode: 0o700 });
    if (process.platform === "win32") secureDirStrict(path);
  }

  private ensureParents(relative: string): void {
    const parts = relative.split("/");
    for (let end = 1; end < parts.length; end++) {
      this.ensureDirectory(parts.slice(0, end).join("/"));
    }
  }

  private assertParent(path: string): void {
    const directory = dirname(path);
    if (directory !== realpathSync(directory)) throw new Error("Incoming runtime parent changed");
  }

  private packageFile(relative: string, bytes: Buffer): void {
    const item: TreeFile = {
      path: relative,
      kind: "file",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      executable: false,
    };
    this.register(item);
    const path = join(this.tree, relative);
    this.assertParent(path);
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") secureFileStrict(path);
  }

  placePackage(slot: string, root: string, entries: readonly NpmArchiveEntry[]): void {
    for (const entry of entries) {
      const relative = entry.path === root ? "" : entry.path.slice(root.length + 1);
      if (relative && (!relativePath(relative) || unsupportedRuntimePath(relative)))
        throw new Error("Incoming runtime package path unsupported");
      const path = relative ? posix.join(slot, relative) : slot;
      this.ensureParents(path);
      if (entry.kind === "directory") this.ensureDirectory(path);
      else this.packageFile(path, entry.bytes);
    }
  }

  manifest(): string {
    // NUL sorts before every legal filename byte and separates path components.
    // This gives the same directory-first traversal order as captureTree.
    const ordered = [...this.directoriesAndFiles.values()].map((entry) => ({
      entry,
      sort: Buffer.from(entry.path.replaceAll("/", "\0")),
    }));
    ordered.sort((left, right) => Buffer.compare(left.sort, right.sort));
    return snapshotManifest(
      ordered.map(({ entry }) => entry),
      this.limits.maxManifestBytes,
    );
  }
}

/** Build only from the sealed source tree and the retained, reverified package bytes. */
export function materializeRunTree(
  approved: ApprovedRunTree,
  workspace: string,
): MaterializedRunTree {
  const copy = captureIncomingSnapshot(
    join(approved.mounted, "tree"),
    join(workspace, "projection"),
  );
  if (copy.digest !== snapshotDigest(approved.manifest))
    throw new Error("Incoming runtime source changed");
  const writer = new RuntimeTreeWriter(copy.tree, approved.entries);
  const results = inspectCandidateArchives(
    approved.mounted,
    approved.inventory.artifacts,
    (selection, root, entries) => writer.placePackage(selection.packagePath, root, entries),
  );
  if (results.some((result) => result.status !== "verified"))
    throw new Error("Incoming archive changed");
  return { tree: copy.tree, manifest: writer.manifest() };
}

export function verifyMaterializedRunTree(tree: string, expected: string): boolean {
  const limits = snapshotLimits();
  try {
    return (
      snapshotManifest(captureTree(tree, limits).entries, limits.maxManifestBytes) === expected
    );
  } catch {
    return false;
  }
}
