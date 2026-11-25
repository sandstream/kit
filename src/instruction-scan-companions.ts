/**
 * The Markdown files a skill tells the agent to read. A `SKILL.md` is often a table of contents:
 * "for phase two, read [PHASE2.md](PHASE2.md)", "apply the instructions in references/format.md".
 * The agent reads those files as instructions too, so the instruction rules read them with the
 * `SKILL.md` instead of stopping at the fixed file names (kit-research `fx-companion`).
 *
 * Read, per `SKILL.md`, one hop and bounded:
 *   - every `.md` file it links (`[x](PHASE2.md)`) or names (`references/format.md`), and
 *   - every `.md` file directly in its `references/` directory.
 * A name must resolve inside the skill's own directory: no URL, no absolute path, no `..` out of
 * it, also after symlinks are resolved. A file those companions name in turn is not followed.
 * Only regular files that exist are returned; reading them stays with `readInstructionFile`,
 * which bounds size and refuses special files.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, posix, relative, sep } from "node:path";

/** Companions read per `SKILL.md`; the rest are reported as a coverage gap. */
export const MAX_COMPANIONS_PER_SKILL = 20;

/** `[text](target)` and bare or backticked `name.md` / `dir/name.md` tokens. */
const LINK = /\]\(\s*<?([^)\s>]+\.md)(?:#[^)\s>]*)?>?(?:\s+"[^"]*")?\s*\)/gi;
const NAME = /(?:^|[\s`'"(:])((?:[\w.-]+\/)*[\w.-]+\.md)(?=$|[\s`'".,;:)!?])/gim;

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The `.md` paths a SKILL.md text links or names, as written, in order of first mention. */
export function namedMarkdown(text: string): string[] {
  const found: string[] = [];
  for (const re of [LINK, NAME]) {
    for (const m of text.matchAll(re)) found.push(decode(m[1]));
  }
  return [...new Set(found)];
}

/** Whether a `relative()` result stays below its base. */
function below(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `name` as a `/` path relative to `skillDir`, or null when it is a URL or leaves the directory. */
function inside(skillDir: string, name: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(name) || isAbsolute(name) || name.startsWith("/")) return null;
  const rel = relative(skillDir, normalize(join(skillDir, name)));
  if (!below(rel)) return null;
  return rel.split(sep).join(posix.sep);
}

/**
 * A regular file (not a symlink) whose real path is still inside the skill directory: a linked
 * file or a symlinked `references/` could otherwise point a skill's "reference" anywhere on disk.
 * Real paths, because macOS's `/tmp` is itself a symlink to `/private/tmp`.
 */
function isOwnFile(skillDir: string, path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    return below(relative(realpathSync(skillDir), realpathSync(path)));
  } catch {
    return false;
  }
}

function referenceFiles(skillDir: string): string[] {
  try {
    return readdirSync(join(skillDir, "references"))
      .filter((n) => n.toLowerCase().endsWith(".md"))
      .sort()
      .map((n) => `references/${n}`);
  } catch {
    return [];
  }
}

/**
 * The companion files of one `SKILL.md`, relative to the skill directory, that exist; and the ones
 * left out because the per-skill bound was reached.
 */
export function skillCompanions(
  skillDir: string,
  skillText: string,
): { files: string[]; dropped: string[] } {
  const candidates = [...namedMarkdown(skillText), ...referenceFiles(skillDir)];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const name of candidates) {
    const rel = inside(skillDir, name);
    if (!rel || rel.toLowerCase() === "skill.md" || seen.has(rel.toLowerCase())) continue;
    seen.add(rel.toLowerCase());
    if (isOwnFile(skillDir, join(skillDir, ...rel.split("/")))) files.push(rel);
  }
  return {
    files: files.slice(0, MAX_COMPANIONS_PER_SKILL),
    dropped: files.slice(MAX_COMPANIONS_PER_SKILL),
  };
}

/** The `SKILL.md` among `files` (relative `/` paths), with the directory its companions live in. */
export function skillFiles(files: string[]): { rel: string; dir: string }[] {
  return files
    .filter((f) => posix.basename(f).toLowerCase() === "skill.md")
    .map((rel) => ({ rel, dir: posix.dirname(rel) }));
}

/** Join a skill directory (`.` for the root) and a companion path into one `/` path. */
export function companionPath(dir: string, rel: string): string {
  return dir === "." ? rel : `${dir}/${rel}`;
}
