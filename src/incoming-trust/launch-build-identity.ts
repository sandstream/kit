import { createHash } from "node:crypto";
import { lstatSync, opendirSync, realpathSync, type BigIntStats } from "node:fs";
import { join } from "node:path";
import { readSnapshotFile, unchanged } from "./snapshot-io.js";

interface BuildFile {
  path: string;
  info: BigIntStats;
}

interface BuildContents {
  entries: number;
  bytes: number;
  observations: BuildFile[];
  modules: [string, string][];
}

function productionModule(name: string): boolean {
  return /\.(?:js|mjs|cjs|json|node)$/.test(name) && !/\.test(?:-support)?\.js$/.test(name);
}

function recordModule(path: string, key: string, info: BigIntStats, build: BuildContents): void {
  const remaining = 128 * 1024 * 1024 - build.bytes;
  const file = readSnapshotFile(path, info, remaining);
  build.bytes += file.size;
  build.modules.push([key, file.sha256]);
  build.observations.push({ path, info });
}

function inventoryBuild(
  path: string,
  key: string,
  info: BigIntStats,
  build: BuildContents,
  depth: number,
): void {
  if (!info.isDirectory() || depth > 32) throw new Error("Invalid Kit build directory");
  build.observations.push({ path, info });
  const directory = opendirSync(path);
  try {
    for (let row = directory.readSync(); row; row = directory.readSync()) {
      if (++build.entries > 20_000) throw new Error("Kit build entry limit");
      const child = join(path, row.name);
      const childKey = key ? key + "/" + row.name : row.name;
      const stat = lstatSync(child, { bigint: true });
      if (stat.isDirectory()) inventoryBuild(child, childKey, stat, build, depth + 1);
      else if (productionModule(row.name)) recordModule(child, childKey, stat, build);
      else if (stat.isSymbolicLink()) throw new Error("Linked Kit build entry");
    }
  } finally {
    directory.closeSync();
  }
}

function stillPresent(item: BuildFile): boolean {
  const current = lstatSync(item.path, { bigint: true, throwIfNoEntry: false });
  return current !== undefined && unchanged(item.info, current);
}

function captureBuild(path: string) {
  const build: BuildContents = { entries: 0, bytes: 0, observations: [], modules: [] };
  inventoryBuild(path, "", lstatSync(path, { bigint: true }), build, 0);
  if (!build.modules.some(([name]) => name === "cli.js") || !build.observations.every(stillPresent))
    throw new Error("Incomplete or changed Kit build");
  build.modules.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256").update(JSON.stringify(build.modules)).digest("hex");
  return { digest, observations: build.observations };
}

export function fingerprintKitBuild(root: string) {
  const path = realpathSync(root);
  const { digest, observations } = captureBuild(path);
  return {
    digest,
    check: () => {
      try {
        // A directory or file can change within one filesystem timestamp tick.
        return observations.every(stillPresent) && captureBuild(path).digest === digest;
      } catch {
        return false;
      }
    },
  };
}
