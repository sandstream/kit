/**
 * The repository half of instruction constraints: does the code a rule line names still exist,
 * and which rule lines did the working tree drop since `HEAD`.
 *
 * Every read is bounded: the tree listing by entry count, the text search by file count, file
 * size and total bytes, and each git call by a timeout and an output cap. git is only read
 * (`diff`, `show`, `grep`, `log`, `check-ignore`), never written. A bound reached or a git call
 * that failed is reported as an incomplete scan, never as a clean one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, posix } from "node:path";
import {
  discoverInstructionFiles,
  isInstructionFile,
  readInstructionFile,
} from "./instruction-scan-files.js";
import {
  constraintRefs,
  isConstraintLine,
  ruleChanges,
  type ConstraintRef,
  type RuleChange,
} from "./instruction-constraints.js";

const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  "vendor",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
]);
const MAX_ENTRIES = 50_000;
const MAX_SEARCH_FILES = 20_000;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const MAX_SEARCH_BYTES = 64_000_000;
const MAX_HISTORY_LOOKUPS = 100;
const GIT_TIMEOUT_MS = 15_000;
const PROSE = /\.(md|mdc|markdown|txt|rst)$/i;

interface Git {
  ok: boolean;
  /** git ran and said "nothing" (exit 1 for grep and check-ignore). */
  none: boolean;
  out: string;
}

function git(root: string, args: string[], input?: string): Git {
  const r = spawnSync(
    "git",
    ["-C", root, "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", ...args],
    {
      encoding: "utf8",
      input,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    },
  );
  const ok = !r.error && r.status === 0;
  return { ok, none: !r.error && r.status === 1, out: ok ? r.stdout : "" };
}

/** True when `root` is in a git work tree with at least one commit. */
function hasHead(root: string): boolean {
  return git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).ok;
}

// --- The tree ---------------------------------------------------------------------------------

interface TreeIndex {
  /** Repository-relative paths with `/`, files only. */
  files: string[];
  complete: boolean;
}

/** List the files under `root`, skipping VCS, dependency and build directories. */
function listTree(root: string): TreeIndex {
  const files: string[] = [];
  let seen = 0;
  let complete = true;
  const visit = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) {
        complete = false;
        return;
      }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) visit(join(abs, e.name), childRel);
      } else files.push(childRel);
    }
  };
  visit(root, "");
  return { files, complete };
}

const isDir = (abs: string): boolean => {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
};

/** Where a path token resolves: next to the instruction file, at the root, or anywhere by suffix. */
function resolvesPath(root: string, from: string, probe: string, index: TreeIndex): boolean {
  const parts = probe.split("/");
  if (existsSync(join(root, ...from.split("/").filter(Boolean), ...parts))) return true;
  if (existsSync(join(root, ...parts))) return true;
  if (!probe.includes("/")) return index.files.some((f) => posix.basename(f) === probe);
  return index.files.some((f) => f.endsWith(`/${probe}`) || f.startsWith(`${probe}/`));
}

/**
 * An extensionless token with a separator (`owner/repo`, `release/v1`) is a repository path only
 * when its first segment exists next to the instruction file or at the root.
 */
function looksLikeRepoPath(root: string, from: string, probe: string): boolean {
  if (/\.[A-Za-z0-9]+$/.test(probe) || probe.startsWith(".")) return true;
  const first = probe.split("/")[0]!;
  return isDir(join(root, ...from.split("/").filter(Boolean), first)) || isDir(join(root, first));
}

function readHead(path: string, limit: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(limit + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > limit || buf.subarray(0, Math.min(n, 4096)).includes(0)) return null;
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Which of `probes` occur in the tree's code and config files: not prose (`.md`, `.txt`) and not
 * an instruction file, whose own rule lines would otherwise make every token "present".
 */
function searchCode(
  root: string,
  index: TreeIndex,
  probes: Set<string>,
  exclude: ReadonlySet<string>,
): { found: Set<string>; complete: boolean } {
  const found = new Set<string>();
  const pending = new Set(probes);
  let files = 0;
  let bytes = 0;
  for (const rel of index.files) {
    if (pending.size === 0) break;
    if (PROSE.test(rel) || exclude.has(rel)) continue;
    if (++files > MAX_SEARCH_FILES || bytes > MAX_SEARCH_BYTES) return { found, complete: false };
    const text = readHead(join(root, ...rel.split("/")), MAX_SEARCH_FILE_BYTES);
    if (text === null) continue;
    bytes += text.length;
    for (const p of pending) {
      if (text.includes(p)) {
        found.add(p);
        pending.delete(p);
      }
    }
  }
  return { found, complete: index.complete };
}

/** The probes that occur in `HEAD`'s files other than Markdown. Null when git could not answer. */
function headHas(root: string, probes: string[]): Set<string> | null {
  if (probes.length === 0) return new Set();
  const args = ["grep", "-F", "-o", "-h", "-I", "--no-color"];
  for (const p of probes) args.push("-e", p);
  const r = git(root, [...args, "HEAD", "--", ".", ":(exclude)*.md", ":(exclude)*.mdc"]);
  if (r.none) return new Set();
  if (!r.ok) return null;
  return new Set(r.out.split(/\r?\n/).filter(Boolean));
}

function ignoredPaths(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const r = git(root, ["check-ignore", "--stdin"], paths.join("\n") + "\n");
  return new Set(r.out.split(/\r?\n/).filter(Boolean));
}

// --- Part a: rule lines naming code that is gone ----------------------------------------------

export interface DanglingRef extends ConstraintRef {
  /** `missing`: not in the tree; `removed`: in `HEAD`, not in the tree; `deleted`: in git history. */
  evidence: "missing" | "removed" | "deleted";
}

export interface ConstraintScan {
  files: number;
  ruleLines: number;
  refs: ConstraintRef[];
  /** Tokens looked up (paths that are repository paths, identifiers, env vars). */
  checked: number;
  dangling: DanglingRef[];
  /** What was not fully read or answered, for the row. */
  incomplete: string[];
}

interface Lookup {
  root: string;
  index: TreeIndex;
  git: boolean;
  incomplete: string[];
}

/** A placeholder segment such as `NNNN_slug.sql` or `XXX.md`: a naming pattern, not a file. */
const PLACEHOLDER = /([A-Z])\1{2,}/;
const dirOf = (file: string): string => (posix.dirname(file) === "." ? "" : posix.dirname(file));

/** The repository paths a token may mean: next to the instruction file, then from the root. */
const candidates = (r: ConstraintRef): string[] => [
  ...new Set([posix.join(dirOf(r.file) || ".", r.probe), r.probe]),
];

function parentExists(root: string, paths: string[]): boolean {
  return paths.some((p) => isDir(join(root, ...posix.dirname(p).split("/"))));
}

interface PathBudget {
  ignored: Set<string>;
  lookups: number;
}

/**
 * Why a missing path token names code that is gone, or null. Once committed and now deleted is
 * evidence under any rule word. Never committed counts only for a rule that requires the path
 * ("always run `scripts/sync.sh`") inside a directory that exists: "never commit
 * `config/secrets.yml`" is obeyed when the file is absent, and a bare `routes.txt` is often a file
 * the agent is told to write.
 */
function pathEvidence(r: ConstraintRef, ctx: Lookup, budget: PathBudget): DanglingRef | null {
  const paths = candidates(r);
  if (paths.some((p) => budget.ignored.has(p))) return null;
  if (ctx.git && ++budget.lookups <= MAX_HISTORY_LOOKUPS) {
    const log = git(ctx.root, ["log", "-1", "--format=%h", "HEAD", "--", ...paths]);
    if (log.ok && log.out.trim()) return { ...r, evidence: "deleted" };
  } else if (ctx.git && budget.lookups === MAX_HISTORY_LOOKUPS + 1) {
    ctx.incomplete.push(`history lookups over ${MAX_HISTORY_LOOKUPS}`);
  }
  const required = !r.prohibitive && r.probe.includes("/");
  return required && parentExists(ctx.root, paths) ? { ...r, evidence: "missing" } : null;
}

function danglingPaths(refs: ConstraintRef[], ctx: Lookup): DanglingRef[] {
  const missing = refs.filter(
    (r) =>
      !PLACEHOLDER.test(r.probe) &&
      looksLikeRepoPath(ctx.root, dirOf(r.file), r.probe) &&
      !resolvesPath(ctx.root, dirOf(r.file), r.probe, ctx.index),
  );
  const all = [...new Set(missing.flatMap(candidates))];
  const budget: PathBudget = {
    ignored: ctx.git ? ignoredPaths(ctx.root, all) : new Set(),
    lookups: 0,
  };
  return missing.flatMap((r) => pathEvidence(r, ctx, budget) ?? []);
}

/**
 * Names (identifiers, env vars) the code search did not find. A name counts as gone only when
 * `HEAD`'s code still has it: an absent `NewGuid` under "never" is the rule obeyed, and an absent
 * `SubdomainScan` under "only" is usually another tool's name. So a name removed in an earlier
 * commit is not found; the check is meant to run before a commit, as `kit check` does.
 */
function danglingNames(refs: ConstraintRef[], ctx: Lookup, exclude: Set<string>): DanglingRef[] {
  if (refs.length === 0) return [];
  const search = searchCode(ctx.root, ctx.index, new Set(refs.map((r) => r.probe)), exclude);
  if (!search.complete) ctx.incomplete.push("code search bound reached");
  const absent = refs.filter((r) => !search.found.has(r.probe));
  if (absent.length === 0 || !ctx.git) return [];
  const head = headHas(ctx.root, [...new Set(absent.map((r) => r.probe))]);
  if (head === null) ctx.incomplete.push("git grep HEAD did not answer");
  return absent.flatMap((r) =>
    head?.has(r.probe) ? [{ ...r, evidence: "removed" as const }] : [],
  );
}

/** Part a over kit's instruction-file list under `root`. */
export function scanConstraints(root: string): ConstraintScan {
  const discovery = discoverInstructionFiles(root);
  const incomplete = discovery.coverageGaps.map((g) => `${g.path} (${g.reason})`);
  const refs: ConstraintRef[] = [];
  let ruleLines = 0;
  for (const file of discovery.files) {
    const text = readInstructionFile(join(root, ...file.split("/")));
    if (text === null) {
      incomplete.push(`${file} (unread)`);
      continue;
    }
    ruleLines += text.split(/\r?\n/).filter(isConstraintLine).length;
    refs.push(...constraintRefs(file, text));
  }
  const ctx: Lookup = { root, index: listTree(root), git: hasHead(root), incomplete };
  if (!ctx.index.complete) incomplete.push(`tree listing over ${MAX_ENTRIES} entries`);
  const paths = refs.filter((r) => r.kind === "path");
  const names = refs.filter((r) => r.kind !== "path");
  const dangling = [
    ...danglingPaths(paths, ctx),
    ...danglingNames(names, ctx, new Set(discovery.files)),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    files: discovery.files.length,
    ruleLines,
    refs,
    checked: refs.length,
    dangling,
    incomplete,
  };
}

// --- Part b: rule lines removed or weakened since HEAD ----------------------------------------

export interface HeadComparison {
  /** False when there is no git work tree with a commit: nothing to compare. */
  compared: boolean;
  changedFiles: string[];
  changes: RuleChange[];
  incomplete: string[];
}

/** Part b: each changed instruction file's committed rule lines against the working tree. */
export function compareWithHead(root: string): HeadComparison {
  if (!hasHead(root)) return { compared: false, changedFiles: [], changes: [], incomplete: [] };
  const diff = git(root, [
    "diff",
    "--no-renames",
    "--relative",
    "--diff-filter=MDT",
    "--name-only",
    "-z",
    "HEAD",
    "--",
  ]);
  if (!diff.ok) {
    return { compared: true, changedFiles: [], changes: [], incomplete: ["git diff HEAD failed"] };
  }
  const discovery = discoverInstructionFiles(root);
  const known = new Set(discovery.files);
  const changed = diff.out
    .split("\0")
    .filter((rel) => rel && (known.has(rel) || isInstructionFile(rel)));
  const changes: RuleChange[] = [];
  const incomplete: string[] = [];
  for (const rel of changed) {
    const committed = git(root, ["show", `HEAD:./${rel}`]);
    if (!committed.ok) {
      incomplete.push(`${rel} (HEAD version unread)`);
      continue;
    }
    const current = readInstructionFile(join(root, ...rel.split("/")));
    changes.push(...ruleChanges(rel, committed.out, current));
  }
  return { compared: true, changedFiles: changed, changes, incomplete };
}
