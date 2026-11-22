/**
 * Binds a skill triage to the skill's content. The `kit triage check-skills` gate used to accept
 * any deep skill entry whose target ended in the same name: a triage of an unrelated directory
 * called `demo`, or of `demo` before an edit, let any later content of `.claude/skills/demo`
 * commit for 30 days. A triage now records a digest of the files it read, and the gate compares
 * it with the digest of what is staged.
 *
 * The digest covers the file type, path relative to the skill directory
 * (with `/` separators), and its bytes, with CRLF read as LF so a Windows checkout with
 * `core.autocrlf` digests the same as the index. A symlink counts as its target text, as git
 * stores it. Pure apart from the two readers.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

export interface SkillFile {
  /** Path relative to the skill directory, `/`-separated. */
  path: string;
  bytes: Buffer;
  executable?: boolean;
  symlink?: boolean;
}

const SKILLS_DIR = [".claude", "skills"];
const MAX_FILES = 2000;

/** The skill name of a triage target: the last path segment, for `/` and `\` alike. */
export function skillName(target: string): string {
  const parts = target.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? target;
}

/** One digest for a skill's files, whatever order they were read in. Pure. */
export function skillDigest(files: SkillFile[]): string {
  const hash = createHash("sha256");
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    const text = Buffer.from(f.bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
    const kind = f.symlink ? "link" : "file";
    hash.update(`${kind}\0${f.path}\0${text.length}\0`);
    hash.update(text);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * A bare skill name resolves to `.claude/skills/<name>` under `cwd` when that holds a SKILL.md, so
 * the command the gate prints (`kit triage skill <name> --deep`) triages the staged skill instead
 * of looking the name up as a GitHub repository. Anything else is returned unchanged.
 */
export function resolveSkillTarget(target: string, cwd: string): string {
  if (!target || isAbsolute(target) || /[\\/]/.test(target)) return target;
  const local = join(cwd, ...SKILLS_DIR, target);
  return existsSync(join(local, "SKILL.md")) ? join(...SKILLS_DIR, target) : target;
}

/**
 * A regular file's bytes, read from one descriptor: opened without following a symlink and checked
 * with fstat on that descriptor, so a swap between listing and reading cannot redirect the read.
 */
function readRegularFile(path: string): Omit<SkillFile, "path"> {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${path} is no longer a regular file`);
    return { bytes: readFileSync(fd), executable: Boolean(stat.mode & 0o111) };
  } finally {
    closeSync(fd);
  }
}

/** Files of a skill directory on disk; null when the target is not a local skill. */
export function readSkillDir(dir: string, regularFilesOnly = false): SkillFile[] | null {
  if (!existsSync(join(dir, "SKILL.md"))) return null;
  const root = resolve(dir);
  if (regularFilesOnly && !lstatSync(root).isDirectory())
    throw new Error("The skill must be a regular directory.");
  const files: SkillFile[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(abs, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({ path: rel, ...readRegularFile(path) });
      else if (regularFilesOnly) throw new Error("Deep triage requires regular skill files.");
      else if (entry.isSymbolicLink())
        files.push({ path: rel, bytes: Buffer.from(readlinkSync(path)), symlink: true });
      if (files.length > MAX_FILES) throw new Error(`skill has over ${MAX_FILES} files`);
    }
  };
  walk(root);
  return files;
}

/** Give both scanners the same local files that the receipt hashes. */
export async function withLocalSkillSnapshot<T>(
  target: string,
  scan: (path: string, snapshot?: { digest: string; fileCount: number }) => Promise<T>,
): Promise<T> {
  if (!existsSync(target)) return scan(target);
  const files = readSkillDir(target, true);
  if (!files) throw new Error("Deep triage requires a skill directory with its own SKILL.md.");

  const temp = await mkdtemp(join(tmpdir(), "kit-skill-scan-"));
  try {
    const path = join(temp, basename(resolve(target)));
    for (const file of files) {
      const destination = join(path, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, file.bytes, { mode: file.executable ? 0o700 : 0o600 });
    }
    return await scan(path, { digest: skillDigest(files), fileCount: files.length });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/** The staged (index) files of `.claude/skills/<name>`, read from git. */
export function readStagedSkill(name: string, cwd: string): SkillFile[] {
  const prefix = `${SKILLS_DIR.join("/")}/${name}/`;
  const listed = execFileSync("git", ["ls-files", "-s", "-z", "--", prefix], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const files: SkillFile[] = [];
  for (const record of listed.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, blob] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    const bytes = execFileSync("git", ["cat-file", "blob", blob], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    files.push({
      path: path.slice(prefix.length),
      bytes,
      symlink: mode === "120000",
    });
  }
  return files;
}
