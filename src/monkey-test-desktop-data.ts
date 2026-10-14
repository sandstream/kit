import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { parse as parseToml } from "smol-toml";

function globSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 2;
    } else if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return source;
}

/** `*` matches inside one folder, `**` across folders. Paths use `/`. */
export function matchesDataGlob(path: string, pattern: string): boolean {
  return new RegExp(`^${globSource(pattern)}$`).test(path);
}

/** Every regular file under `root`, as `/`-separated relative paths. Symlinks are not followed. */
function walk(root: string, prefix = ""): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export interface DataFileCheck {
  /** Files the globs matched. */
  files: string[];
  /** Files that did not parse: torn writes, empty files, or plain corruption. */
  corrupt: { file: string; error: string }[];
  /** Matched files kit cannot parse because their type is not JSON, JSON Lines, or TOML. */
  unchecked: string[];
}

function parseDataFile(path: string): "ok" | "unchecked" {
  const ext = extname(path).toLowerCase();
  const text = readFileSync(path, "utf8");
  if (ext === ".json") {
    if (text.trim().length === 0) throw new Error("empty file");
    JSON.parse(text);
    return "ok";
  }
  if (ext === ".jsonl" || ext === ".ndjson") {
    for (const line of text.split("\n")) if (line.trim()) JSON.parse(line);
    return "ok";
  }
  if (ext === ".toml") {
    parseToml(text);
    return "ok";
  }
  return "unchecked";
}

export function checkDataFiles(dataDir: string, globs: string[]): DataFileCheck {
  const files = walk(dataDir).filter((file) => globs.some((glob) => matchesDataGlob(file, glob)));
  const result: DataFileCheck = { files, corrupt: [], unchecked: [] };
  for (const file of files) {
    try {
      if (parseDataFile(join(dataDir, file)) === "unchecked") result.unchecked.push(file);
    } catch (error) {
      result.corrupt.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

/**
 * One line per file (path, size, modification time) for each folder, or "missing". Two
 * equal fingerprints mean no file was added, removed, or rewritten.
 */
export function fingerprintDirs(dirs: string[], ignore: string[]): Record<string, string> {
  const ignored = (file: string) =>
    ignore.some((entry) => file === entry || file.startsWith(`${entry}/`));
  const prints: Record<string, string> = {};
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      prints[dir] = "missing";
      continue;
    }
    prints[dir] = walk(dir)
      .filter((file) => !ignored(file))
      .sort()
      .map((file) => {
        const info = lstatSync(join(dir, file));
        return `${file}:${info.size}:${info.mtimeMs}`;
      })
      .join("\n");
  }
  return prints;
}
