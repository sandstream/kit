/**
 * Binds a skill triage to the skill's content. The `kit triage check-skills` gate used to accept
 * any deep skill entry whose target ended in the same name: a triage of an unrelated directory
 * called `demo`, or of `demo` before an edit, let any later content of `.claude/skills/demo`
 * commit for 30 days. A triage now records a digest of the files it read, and the gate compares
 * it with the digest of what is staged.
 *
 * The digest covers every file under the skill directory: its path relative to that directory
 * (with `/` separators) and its bytes, with CRLF read as LF so a Windows checkout with
 * `core.autocrlf` digests the same as the index. A symlink counts as its target text, as git
 * stores it. Pure apart from the two readers.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface SkillFile {
  /** Path relative to the skill directory, `/`-separated. */
  path: string;
  bytes: Buffer;
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
    hash.update(`${f.path}\0${text.length}\0`);
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

/** Files of a skill directory on disk; null when the target is not a local skill. */
export function readSkillDir(dir: string): SkillFile[] | null {
  if (!existsSync(join(dir, "SKILL.md"))) return null;
  const root = resolve(dir);
  const files: SkillFile[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(abs, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) files.push({ path: rel, bytes: Buffer.from(readlinkSync(path)) });
      else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path: rel, bytes: readFileSync(path) });
      if (files.length > MAX_FILES) throw new Error(`skill has over ${MAX_FILES} files`);
    }
  };
  walk(root);
  return files;
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
    const [, blob] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    const bytes = execFileSync("git", ["cat-file", "blob", blob], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    files.push({ path: path.slice(prefix.length), bytes });
  }
  return files;
}
