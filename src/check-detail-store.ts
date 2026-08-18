/**
 * Durable store for full `kit_check` runs, so the MCP response can hand back a reference
 * instead of the whole document (see `check-mcp-summary.ts` for why).
 *
 * The constraint that shapes this file: **the reference must resolve to something that still
 * exists.** Offloading output to a pointer that has already been cleaned up trades tokens for
 * a dangling path, which is worse than the verbosity it replaced. So the write happens before
 * the response is built, a failed write is reported as "no reference" rather than swallowed,
 * and pruning keeps the newest runs rather than deleting by age.
 *
 * Location: `.kit/runs/` — already gitignored (`.kit/*` with a `!.kit/shared/` exception), so
 * these never become repo noise.
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

export const RUNS_DIR = join(".kit", "runs");
/** How many runs to keep. Enough for an agent's check → fix → check loop to look back. */
export const KEEP_RUNS = 10;

const FILE_RE = /^check-(\d+)\.json$/;

/**
 * Write one full run and return its path, or null when it could not be written.
 *
 * `stamp` is passed in rather than read from the clock so a caller can make the name
 * deterministic; it is a millisecond timestamp and the sort order of the filenames is the
 * order of the runs.
 */
export function writeCheckDetail(
  cwd: string,
  payload: unknown,
  stamp: number,
): { path: string; hint: string } | null {
  const dir = join(cwd, RUNS_DIR);
  const file = join(dir, `check-${stamp}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  } catch {
    return null; // read-only checkout, missing permission — say "no reference", never lie about one
  }
  pruneCheckDetails(cwd);
  return {
    path: file,
    hint: "complete run, including every passing check — read this file only if the summary is not enough",
  };
}

/** Keep the newest KEEP_RUNS documents; ignore anything not written by this store. */
export function pruneCheckDetails(cwd: string, keep = KEEP_RUNS): string[] {
  const dir = join(cwd, RUNS_DIR);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const mine = names
    .filter((n) => FILE_RE.test(n))
    .sort((a, b) => Number(b.match(FILE_RE)![1]) - Number(a.match(FILE_RE)![1]));
  const removed: string[] = [];
  for (const name of mine.slice(keep)) {
    try {
      rmSync(join(dir, name));
      removed.push(name);
    } catch {
      // A file we cannot delete is not a reason to fail the check that just ran.
    }
  }
  return removed;
}
