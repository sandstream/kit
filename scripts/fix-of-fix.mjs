// Fixes that rewrite a fix. A fix can add a bug, so the release prep names the fix commits since
// the previous tag that change lines another fix in the same range wrote: the pairs to read
// before tagging. kit-research `linus-fixes-add-bugs-vs-kit` counted 8 of 39 in 7.5.0..7.6.0 and
// 22 of 87 in 7.4.0..7.5.0, one of them a regression the earlier fix introduced.
//
// Git only, no model, and informational: it never fails a release. `git` is spawned without a
// shell, so it runs the same on Windows.
//
// Usage:
//   node scripts/fix-of-fix.mjs [<range>]    default: <previous v* tag>..HEAD
import { spawnSync } from "node:child_process";

/** Paths whose fixes are counted: code, not docs or tests' fixtures elsewhere. */
export const FIX_PATHS = ["src", "scripts", "skills"];

const FIX_SUBJECT = /^fix\b/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? /;
const BLAME_HEADER = /^([0-9a-f]{40}) \d+ \d+/;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

/** The old-side line ranges a `git diff -U0` removes or changes, as `{ file, start, count }`. */
export function removedRanges(diff) {
  const out = [];
  let file = null;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("--- ")) {
      file = line.startsWith("--- a/") ? line.slice(6) : null;
      continue;
    }
    const m = HUNK.exec(line);
    if (!m || file === null) continue;
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) out.push({ file, start: Number(m[1]), count });
  }
  return out;
}

/** The commit ids a `git blame --porcelain` output attributes lines to. */
export function blameOrigins(porcelain) {
  const ids = new Set();
  for (const line of porcelain.split("\n")) {
    const m = BLAME_HEADER.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function commitsIn(cwd, range) {
  return git(cwd, ["log", "--no-merges", "--reverse", "--format=%H %s", range])
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ id: l.slice(0, 40), subject: l.slice(41) }));
}

function originsOf(cwd, id) {
  const diff = git(cwd, ["diff", "-U0", `${id}^`, id, "--", ...FIX_PATHS]);
  const origins = new Set();
  for (const { file, start, count } of removedRanges(diff)) {
    const blame = git(cwd, [
      "blame",
      "--porcelain",
      "-L",
      `${start},+${count}`,
      `${id}^`,
      "--",
      file,
    ]);
    for (const origin of blameOrigins(blame)) origins.add(origin);
  }
  return origins;
}

/**
 * The fix commits in `range` that change lines another fix commit in `range` wrote:
 * `{ fixes, pairs: [{ fix, earlier: [...] }] }`, each commit as `{ id, subject }`.
 */
export function fixPairs(cwd, range) {
  const fixes = commitsIn(cwd, range).filter((c) => FIX_SUBJECT.test(c.subject));
  const byId = new Map(fixes.map((c) => [c.id, c]));
  const pairs = [];
  for (const fix of fixes) {
    const earlier = [...originsOf(cwd, fix.id)]
      .filter((id) => id !== fix.id && byId.has(id))
      .sort()
      .map((id) => byId.get(id));
    if (earlier.length > 0) pairs.push({ fix, earlier });
  }
  return { fixes: fixes.length, pairs };
}

/** The range since the previous `v*` tag, or null when the repository has none. */
export function sincePreviousTag(cwd) {
  try {
    return `${git(cwd, ["describe", "--tags", "--abbrev=0", "--match", "v*"]).trim()}..HEAD`;
  } catch {
    return null;
  }
}

/** One line for the release prep. Never throws: a failure is reported, not raised. */
export function fixOfFixLine(cwd, range = sincePreviousTag(cwd)) {
  if (range === null) return "fixes that rewrite a fix: not counted (no previous v* tag)";
  try {
    const { fixes, pairs } = fixPairs(cwd, range);
    const named = pairs
      .map(
        ({ fix, earlier }) =>
          `${fix.id.slice(0, 8)} <- ${earlier.map((c) => c.id.slice(0, 8)).join(", ")}`,
      )
      .join("; ");
    return (
      `fixes that rewrite a fix (${range}): ${pairs.length} of ${fixes} fix commits` +
      (named ? ` — read before tagging: ${named}` : "")
    );
  } catch (err) {
    return `fixes that rewrite a fix: not counted (${err.message})`;
  }
}

if (process.argv[1] && process.argv[1].endsWith("fix-of-fix.mjs")) {
  console.log(fixOfFixLine(process.cwd(), process.argv[2]));
}
