// Preflight gate: refuse to build while a cloud-sync conflict copy sits in a source root.
//
// A repo that lives in iCloud Drive / Dropbox / OneDrive gets a second copy of a file
// whenever the syncer can't reconcile two versions: `triage.ts` gains `triage 2.ts`, and
// a whole directory can reappear as `utils 2/`. These copies are gitignored, which is what
// makes them nasty — `git status` is clean, the working tree looks healthy, and yet `tsc`
// compiles the copy and reports a type error at `src/triage 2.ts:6`, i.e. in code nobody
// wrote and no diff shows. The error names a real line in a file the developer cannot find
// in git, so it reads as a mystery regression in untouched code.
//
// The tempting fix is a tsconfig `exclude` — and it is a trap twice over. First, tsconfig
// globs support only `*`, `?` and `**/`, NOT `[0-9]` character classes, so the obvious
// `**/* [0-9].ts` silently matches nothing and provides fake protection (this repo carried
// exactly that no-op for a while). Second, even a working exclude only *hides* the copy:
// the stale module stays on disk, invisible to git and now invisible to the compiler too.
// Hiding is what made the class hard to see in the first place.
//
// So: fail loudly, name the paths, and say `rm`. Deleting a conflict copy is always safe —
// the original is the tracked file right next to it.
//
// Related: `scripts/test.mjs` refuses to run when the same copies appear under `dist/`
// (there they are stale COMPILED TESTS, which is worse — old assertions against new code).
// This gate covers the source side, before anything is compiled at all.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * True when a basename is a cloud-sync conflict copy rather than a real file.
 *
 * Matches the two shapes syncers actually produce — ` <n>` and ` copy[ <n>]` directly before
 * the extension (`triage 2.ts`, `cli copy.mjs`, `types 2.d.ts`). The counter is capped at two
 * digits on purpose: sync copies count small, so a legitimate `sha2 256.ts` stays a real file.
 *
 * Kept in lockstep with `isSyncDuplicateName` in src/utils/sync-duplicate.ts — see the parity
 * test there. It is duplicated rather than imported because this gate runs BEFORE the build,
 * when `dist/` may be absent or stale.
 */
export function isConflictCopyName(name) {
  return /(?: copy(?: \d{1,2})?| \d{1,2})\.[^.\s]+(?:\.[^.\s]+)*$/.test(name);
}

/** True for a duplicated directory (`utils 2`, `src copy`) — its whole subtree is the copy. */
export function isConflictCopyDir(name) {
  return /(?: copy(?: \d{1,2})?| \d{1,2})$/.test(name);
}

// Only the trees the compiler actually reads. dist/ is covered by clean-dist + scripts/test.mjs,
// and node_modules is not ours to police.
const SOURCE_ROOTS = ["src", "scripts"];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);

function workspaceSourceRoots() {
  if (!existsSync("packages")) return [];
  return readdirSync("packages", { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join("packages", e.name, "src"))
    .filter((p) => existsSync(p));
}

/** Walk a root collecting conflict copies. A copied directory is reported whole, not descended. */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isConflictCopyDir(entry.name)) {
        out.push(`${p}/`);
        continue;
      }
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      collect(p, out);
      continue;
    }
    if (entry.isFile() && isConflictCopyName(entry.name)) out.push(p);
  }
  return out;
}

/** Every conflict copy under the compiled source roots, as repo-relative paths. */
export function findConflictCopies() {
  const roots = [...SOURCE_ROOTS, ...workspaceSourceRoots()].filter((r) => existsSync(r));
  return roots.flatMap((r) => collect(r));
}

function main() {
  const hits = findConflictCopies();
  if (hits.length === 0) return;
  console.error(
    `refusing to build: ${hits.length} cloud-sync conflict cop${hits.length === 1 ? "y" : "ies"} in the source tree —\n` +
      hits.map((h) => `  ${h}`).join("\n") +
      `\n\nThese are iCloud/Dropbox duplicates. They are gitignored, so \`git status\` looks clean,` +
      `\nbut tsc compiles them and reports errors in code you never wrote.` +
      `\nFix (safe — the tracked original sits next to each copy):` +
      `\n${hits.map((h) => `  rm -rf ${JSON.stringify(h.replace(/\/$/, ""))}`).join("\n")}`,
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
