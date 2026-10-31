// Split the compiled test files into shards that run as separate CI jobs (the Windows runner needs
// about 45 minutes for the whole suite and a quarter of that for one of four shards).
//
// The split is greedy and deterministic: the heaviest file goes to the lightest shard, ties to the
// lowest index. Every shard builds the same files, so every shard computes the same partition from the
// same weights, and no file runs twice or not at all.
//
// The weight is the file's measured wall time on the Windows runner (scripts/test-weights.json), the
// platform the shards exist for. File size was within 4% of ideal on Linux, but on Windows it left
// one shard ~1.2x the lightest (#675); a file the table does not know is weighted by its size at the
// table's own ms-per-byte rate, so a new test still lands somewhere sensible.

const MAX_SHARDS = 64;

/**
 * A weight function from a `{ files: { "dist/x.test.js": ms } }` table. Paths are compared with `/`
 * separators, so a Windows checkout reads the same table.
 * @param {{ files?: Record<string, number> } | null} table
 * @param {(file: string) => number} sizeOf
 * @returns {(file: string) => number}
 */
export function weightFrom(table, sizeOf) {
  const known = table?.files ?? {};
  const key = (/** @type {string} */ f) => f.split("\\").join("/");
  let ms = 0;
  let bytes = 0;
  for (const [f, w] of Object.entries(known)) {
    let size;
    try {
      size = sizeOf(f);
    } catch {
      continue;
    }
    ms += w;
    bytes += size;
  }
  const rate = ms > 0 && bytes > 0 ? ms / bytes : 1;
  return (file) => {
    const w = known[key(file)];
    return typeof w === "number" ? w : sizeOf(file) * rate;
  };
}

/**
 * Parse `KIT_TEST_SHARD`, written `index/total` (for example `2/4`). Absent or empty means no sharding.
 * @param {string | undefined} spec
 * @returns {{ index: number, total: number } | null}
 */
export function parseShard(spec) {
  if (spec === undefined || spec === "") return null;
  const m = /^(\d{1,3})\/(\d{1,3})$/.exec(spec);
  const index = m ? Number(m[1]) : 0;
  const total = m ? Number(m[2]) : 0;
  if (!m || index < 1 || total < 1 || total > MAX_SHARDS || index > total) {
    throw new Error(
      `KIT_TEST_SHARD must be index/total with 1 <= index <= total <= ${MAX_SHARDS}, for example 2/4 (got ${JSON.stringify(spec)})`,
    );
  }
  return { index, total };
}

/**
 * The files of one shard, sorted by name.
 * @param {string[]} files
 * @param {{ index: number, total: number }} shard
 * @param {(file: string) => number} sizeOf
 * @returns {string[]}
 */
export function selectShard(files, shard, sizeOf) {
  const bySize = [...files].sort((a, b) => sizeOf(b) - sizeOf(a) || (a < b ? -1 : a > b ? 1 : 0));
  const load = Array.from({ length: shard.total }, () => 0);
  const mine = [];
  for (const file of bySize) {
    let lightest = 0;
    for (let i = 1; i < load.length; i++) if (load[i] < load[lightest]) lightest = i;
    load[lightest] += sizeOf(file);
    if (lightest === shard.index - 1) mine.push(file);
  }
  return mine.sort();
}
