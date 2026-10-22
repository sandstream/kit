/**
 * Installed-version resolution for `kit upstream`. A lockfile wins over the declared range:
 * package-lock.json, bun.lock (text format) and pnpm-lock.yaml are read. When no lockfile lists the
 * package, the lower bound of the declared range is the estimate and the result says so. No yaml
 * dependency is added (ADR-0002): pnpm-lock.yaml is read line by line, only for the two fields needed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isValidVersion } from "./update-check.js";

export type InstalledSource =
  | "package-lock.json"
  | "bun.lock"
  | "pnpm-lock.yaml"
  | "declared-range"
  | "unresolved";

export interface InstalledVersion {
  version: string | null;
  source: InstalledSource;
  /** The range the manifest declares. */
  range: string;
  /** Why a lockfile was passed over, when it was. */
  note?: string;
}

type LockReader = (text: string, name: string, importer: string) => string | null;

function cleanVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const bare = raw.trim().replace(/^v/, "").replace(/\(.*$/, "").replace(/_.*$/, "");
  return isValidVersion(bare) ? bare : null;
}

const readPackageLock: LockReader = (text, name) => {
  const lock = JSON.parse(text) as {
    packages?: Record<string, { version?: unknown }>;
    dependencies?: Record<string, { version?: unknown }>;
  };
  return cleanVersion(
    lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version,
  );
};

const readBunLock: LockReader = (text, name) => {
  const noComments = text.replace(/^\s*\/\/.*$/gm, "");
  const strict = noComments.replace(/,(\s*[}\]])/g, "$1");
  const lock = JSON.parse(strict) as { packages?: Record<string, unknown> };
  const entry = lock.packages?.[name];
  const id = Array.isArray(entry) ? entry[0] : undefined;
  if (typeof id !== "string") return null;
  return cleanVersion(id.slice(id.lastIndexOf("@") + 1));
};

/** Escape every non-word character so a name or folder can sit inside a RegExp. */
function escapeRegex(value: string): string {
  return value.replace(/\W/g, "\\$&");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Lines of the pnpm importer block for `importer` ("." is the root), or all lines for old formats. */
function pnpmImporterLines(lines: string[], importer: string): string[] {
  const start = lines.findIndex((l) => l.trim() === "importers:");
  if (start === -1) return lines;
  const key = new RegExp(`^  ['"]?${escapeRegex(importer)}['"]?:\\s*$`);
  const from = lines.findIndex((l, i) => i > start && key.test(l));
  if (from === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (line.trim() !== "" && indentOf(line) <= 2) break;
    block.push(line);
  }
  return block;
}

function readPnpmLock(text: string, name: string, importer: string): string | null {
  const block = pnpmImporterLines(text.split(/\r?\n/), importer);
  const quoted = escapeRegex(name);
  const header = new RegExp(`^\\s+['"]?${quoted}['"]?:\\s*$`);
  for (let i = 0; i < block.length; i++) {
    if (!header.test(block[i])) continue;
    const depth = indentOf(block[i]);
    for (const line of block.slice(i + 1)) {
      if (line.trim() !== "" && indentOf(line) <= depth) break;
      const m = /^\s+version:\s*(\S+)/.exec(line);
      if (m) return cleanVersion(m[1].replace(/\W*$/, "").replace(/^\W+/, ""));
    }
  }
  return null;
}

const LOCKFILES: { file: string; source: InstalledSource; read: LockReader }[] = [
  { file: "package-lock.json", source: "package-lock.json", read: readPackageLock },
  { file: "bun.lock", source: "bun.lock", read: readBunLock },
  { file: "pnpm-lock.yaml", source: "pnpm-lock.yaml", read: readPnpmLock },
];

/** Lower bound of a range that names a version: `^1.2.3`, `~1.2.3`, `>=1.2.3`, `1.2.3`. */
function rangeLowerBound(range: string): string | null {
  const m = /^\s*(?:\^|~|>=|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(range);
  return m ? cleanVersion(m[1]) : null;
}

/** Folders to look in for a lockfile: the manifest's own folder, then each parent up to the root. */
function lockfileFolders(manifestPath: string): string[] {
  const folders: string[] = [];
  let dir = dirname(manifestPath);
  for (;;) {
    folders.push(dir === "." ? "" : dir);
    if (dir === "." || dir === "/" || dir === "") break;
    dir = dirname(dir);
  }
  return folders;
}

function importerFor(manifestPath: string, folder: string): string {
  const rel = dirname(manifestPath).split("\\").join("/");
  if (rel === ".") return ".";
  return folder === "" ? rel : rel.slice(folder.length + 1) || ".";
}

function tryLockfiles(
  root: string,
  manifestPath: string,
  name: string,
): { hit?: { version: string; source: InstalledSource }; notes: string[] } {
  const notes: string[] = [];
  for (const folder of lockfileFolders(manifestPath)) {
    for (const lock of LOCKFILES) {
      const rel = folder === "" ? lock.file : `${folder}/${lock.file}`;
      let text: string;
      try {
        text = readFileSync(join(root, rel), "utf-8");
      } catch {
        continue;
      }
      try {
        const version = lock.read(text, name, importerFor(manifestPath, folder));
        if (version) return { hit: { version, source: lock.source }, notes };
      } catch (err) {
        notes.push(`${rel} could not be read (${err instanceof Error ? err.message : "error"})`);
      }
    }
    try {
      readFileSync(join(root, folder === "" ? "bun.lockb" : `${folder}/bun.lockb`));
      notes.push("bun.lockb is a binary lockfile kit does not read; save a text bun.lock");
    } catch {
      // no binary lockfile here
    }
  }
  return { notes };
}

export function resolveInstalledVersion(
  root: string,
  manifestPath: string,
  name: string,
  declaredRange: string,
): InstalledVersion {
  const { hit, notes } = tryLockfiles(root, manifestPath, name);
  const note = notes.length > 0 ? notes.join("; ") : undefined;
  if (hit) return { ...hit, range: declaredRange, ...(note ? { note } : {}) };
  const bound = rangeLowerBound(declaredRange);
  const base = { range: declaredRange, ...(note ? { note } : {}) };
  return bound
    ? { version: bound, source: "declared-range", ...base }
    : { version: null, source: "unresolved", ...base };
}
