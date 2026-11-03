/**
 * Installed-version resolution for `kit upstream`. A lockfile wins over the declared range:
 * package-lock.json, bun.lock (text format), pnpm-lock.yaml and yarn.lock (versions 1 and 2+) are read. When no lockfile lists the
 * package, the lower bound of the declared range is the estimate and the result says so. No yaml
 * dependency is added (ADR-0002): pnpm-lock.yaml is read line by line, only for the two fields needed.
 */
import { dirname, join } from "node:path";
import { isValidVersion } from "./update-check.js";
import { entryExists, readRegularFileIfPresent } from "./upstream-safe-read.js";

export type InstalledSource =
  | "package-lock.json"
  | "bun.lock"
  | "pnpm-lock.yaml"
  | "yarn.lock"
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

type LockReader = (text: string, name: string, importer: string, range: string) => string | null;

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

interface YarnEntry {
  /** The descriptors the entry answers for, such as `convex@^1.45.0` or `convex@npm:^1.45.0`. */
  specs: string[];
  version: string | null;
}

const DQ = String.fromCharCode(34);
const YARN_VERSION = /^ {2}version:?\s+\x22?([^\s\x22]+)\x22?\s*$/;

/** The descriptors of one header line. Version 1 quotes each, version 2 and later the whole list. */
function yarnHeaderSpecs(header: string): string[] {
  return header
    .split(DQ)
    .join("")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "");
}

/** The entries of a yarn.lock: an unindented header ending in a colon, then indented fields. */
function yarnEntries(text: string): YarnEntry[] {
  const entries: YarnEntry[] = [];
  let current: YarnEntry | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    if (!line.startsWith(" ") && line.endsWith(":")) {
      current = { specs: yarnHeaderSpecs(line.slice(0, -1)), version: null };
      entries.push(current);
    } else if (current && current.version === null) {
      current.version = YARN_VERSION.exec(line)?.[1] ?? null;
    }
  }
  return entries;
}

/** Name and range of a descriptor; the range loses a Berry `npm:` prefix. An unnamed one gives null. */
function yarnDescriptor(descriptor: string): { name: string; range: string } | null {
  const at = descriptor.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: descriptor.slice(0, at), range: descriptor.slice(at + 1).replace(/^npm:/, "") };
}

/**
 * The version yarn.lock pins for a direct dependency. A package can be locked at several versions
 * (one per range asked for), so the manifest's declared range picks the entry. With no range, only a
 * single locked version is taken; two are not guessed between, and nothing is returned.
 */
function readYarnLock(text: string, name: string, _importer: string, range: string): string | null {
  const own = yarnEntries(text).filter((e) =>
    e.specs.some((spec) => yarnDescriptor(spec)?.name === name),
  );
  if (range !== "") {
    const hit = own.find((e) => e.specs.some((s) => matches(s, name, range)));
    return hit?.version ? cleanVersion(hit.version) : null;
  }
  const versions = new Set(own.map((e) => e.version).filter((v): v is string => v !== null));
  return versions.size === 1 ? cleanVersion([...versions][0]) : null;
}

function matches(spec: string, name: string, range: string): boolean {
  const d = yarnDescriptor(spec);
  return d !== null && d.name === name && d.range === range;
}

const LOCKFILES: { file: string; source: InstalledSource; read: LockReader }[] = [
  { file: "package-lock.json", source: "package-lock.json", read: readPackageLock },
  { file: "bun.lock", source: "bun.lock", read: readBunLock },
  { file: "pnpm-lock.yaml", source: "pnpm-lock.yaml", read: readPnpmLock },
  { file: "yarn.lock", source: "yarn.lock", read: readYarnLock },
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
  range: string,
): { hit?: { version: string; source: InstalledSource }; notes: string[] } {
  const notes: string[] = [];
  for (const folder of lockfileFolders(manifestPath)) {
    for (const lock of LOCKFILES) {
      const rel = folder === "" ? lock.file : `${folder}/${lock.file}`;
      let text: string | null;
      try {
        text = readRegularFileIfPresent(join(root, rel));
      } catch (err) {
        notes.push(`${rel} ${err instanceof Error ? err.message : "could not be read"}`);
        continue;
      }
      if (text === null) continue;
      try {
        const version = lock.read(text, name, importerFor(manifestPath, folder), range);
        if (version) return { hit: { version, source: lock.source }, notes };
      } catch {
        notes.push(`${rel} could not be parsed`);
      }
    }
    if (entryExists(join(root, folder === "" ? "bun.lockb" : `${folder}/bun.lockb`))) {
      notes.push("bun.lockb is a binary lockfile kit does not read; save a text bun.lock");
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
  const { hit, notes } = tryLockfiles(root, manifestPath, name, declaredRange);
  const note = notes.length > 0 ? notes.join("; ") : undefined;
  if (hit) return { ...hit, range: declaredRange, ...(note ? { note } : {}) };
  const bound = rangeLowerBound(declaredRange);
  const base = { range: declaredRange, ...(note ? { note } : {}) };
  return bound
    ? { version: bound, source: "declared-range", ...base }
    : { version: null, source: "unresolved", ...base };
}
