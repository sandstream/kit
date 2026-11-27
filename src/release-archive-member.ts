/**
 * What makes an archive member unsafe to extract, judged from its header alone: a path that
 * leaves the extraction directory, a link that points out of it, a setuid or setgid bit, or a
 * device or other special entry. Paths are read with both `/` and `\` as separators, because a
 * Windows extractor treats `\` as one. Pure.
 */
import { posix } from "node:path";

export interface ArchiveMember {
  name: string;
  kind: "file" | "dir" | "symlink" | "hardlink" | "special";
  /** Unix permission bits, when the format records them (0 otherwise). */
  mode: number;
  /** A link's target. */
  link?: string;
}

const SETUID = 0o4000;
const SETGID = 0o2000;

const slashes = (p: string): string => p.replace(/\\/g, "/");

/** True for `/x`, `C:x`, `C:\x` or `\\host\x`. */
function isAbsolute(p: string): boolean {
  const s = slashes(p);
  return s.startsWith("/") || /^[A-Za-z]:/.test(s);
}

/** True when `p`, taken relative to `from` inside the tree, ends up outside it. */
function escapes(p: string, from = "."): boolean {
  if (isAbsolute(p)) return true;
  const joined = posix.normalize(posix.join(from, slashes(p)));
  return joined === ".." || joined.startsWith("../");
}

const hasDotDot = (p: string): boolean => slashes(p).split("/").includes("..");

/** The reasons one member is unsafe, empty when it is not. */
export function memberFindings(m: ArchiveMember): string[] {
  const out: string[] = [];
  const shown = JSON.stringify(m.name);
  if (/[\u0000-\u001f\u007f]/.test(m.name))
    out.push(`${shown} has a control character in its name`);
  if (isAbsolute(m.name)) out.push(`${shown} is an absolute path`);
  else if (hasDotDot(m.name)) out.push(`${shown} has a ".." component`);
  if (m.kind === "symlink" && m.link !== undefined) {
    const dir = posix.dirname(slashes(m.name));
    if (escapes(m.link, dir))
      out.push(`${shown} is a symlink out of the tree (-> ${JSON.stringify(m.link)})`);
  }
  if (m.kind === "hardlink" && m.link !== undefined && escapes(m.link)) {
    out.push(`${shown} is a hard link out of the tree (-> ${JSON.stringify(m.link)})`);
  }
  if (m.mode & SETUID) out.push(`${shown} is setuid`);
  if (m.mode & SETGID && m.kind !== "dir") out.push(`${shown} is setgid`);
  if (m.kind === "special") out.push(`${shown} is a device, fifo or other special entry`);
  return out;
}
