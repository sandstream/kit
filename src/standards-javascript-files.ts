import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const JAVASCRIPT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);

const EXCLUDED = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "target",
  ".git",
  "coverage",
  "__pycache__",
  ".venv",
]);

export interface JavaScriptInput {
  path: string;
  text: string;
  sha256: string;
}

export function sourceDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function included(path: string): boolean {
  return !path.split(/[\\/]/).some((part) => EXCLUDED.has(part));
}

function walk(root: string, dir: string, visited: Set<string>): string[] {
  const actual = realpathSync(dir);
  if (!within(root, actual)) throw new Error("Source directory leaves the inspected project");
  if (visited.has(actual)) throw new Error("Source directory aliases prevent a complete inventory");
  visited.add(actual);
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, encoding: "buffer" })) {
    const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(entry.name);
    if (EXCLUDED.has(name)) continue;
    const path = join(dir, name);
    const stat = entry.isSymbolicLink() ? statSync(path) : entry;
    if (stat.isDirectory()) files.push(...walk(root, path, visited));
    else if (stat.isFile()) files.push(relative(root, path));
  }
  return files;
}

async function inventory(root: string): Promise<string[]> {
  const args = [
    "-c",
    "core.fsmonitor=false",
    "ls-files",
    "-co",
    "--exclude-standard",
    "-z",
    "--",
    ".",
  ];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  let result;
  try {
    result = await execFileAsync("git", args, {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer",
      env,
    });
  } catch (error) {
    const failure = error as { stderr?: Buffer; code?: string | number };
    // Only an absent executable or a genuinely unversioned directory permits fallback.
    if (
      failure.code === "ENOENT" ||
      (Number(failure.code) === 128 &&
        failure.stderr?.toString("utf8").trim() ===
          "fatal: not a git repository (or any of the parent directories): .git")
    ) {
      return walk(root, root, new Set());
    }
    throw new Error("Git source inventory did not complete", { cause: error });
  }
  if (result.stderr.toString("utf8").trim())
    throw new Error("Git source inventory did not complete");
  const paths = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout);
  return [...new Set(paths.split("\0").filter(Boolean))];
}

function readSource(path: string, limit: number): { text: string; bytes: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Source input is not a regular file");
    if (stat.size > limit) throw new Error("JavaScript input exceeds the analysis limit");
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const chunks: string[] = [];
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, limit - bytes + 1), null);
      if (count === 0) break;
      bytes += count;
      if (bytes > limit) throw new Error("JavaScript input exceeds the analysis limit");
      chunks.push(decoder.decode(buffer.subarray(0, count), { stream: true }));
    }
    chunks.push(decoder.decode());
    return { text: chunks.join(""), bytes };
  } finally {
    closeSync(fd);
  }
}

export async function readJavaScriptInputs(cwd: string): Promise<JavaScriptInput[]> {
  const root = realpathSync(cwd);
  const inputs: JavaScriptInput[] = [];
  let bytes = 0;
  for (const path of (await inventory(root)).sort()) {
    if (!included(path)) continue;
    const full = resolve(root, path);
    if (!within(root, full)) throw new Error("Source inventory leaves the inspected project");
    let entry;
    try {
      entry = lstatSync(full);
    } catch (error) {
      // Git retains index entries for explicitly deleted tracked files.
      // lstat distinguishes an absent entry from a link with a missing target.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory())) {
      // Git lists nested repositories, gitlinks and directory links without their sources.
      throw new Error("Unresolved source directory prevents a complete inventory");
    }
    if (!JAVASCRIPT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const actual = realpathSync(full);
    if (!within(root, actual)) throw new Error("Source file leaves the inspected project");
    const source = readSource(actual, 64 * 1024 * 1024 - bytes);
    bytes += source.bytes;
    const text = source.text;
    inputs.push({ path, text, sha256: sourceDigest(text) });
  }
  return inputs;
}

export function sameJavaScriptInputs(before: JavaScriptInput[], after: JavaScriptInput[]): boolean {
  return (
    before.length === after.length &&
    before.every((file, i) => file.path === after[i]?.path && file.sha256 === after[i]?.sha256)
  );
}
