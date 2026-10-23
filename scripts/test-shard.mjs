// Split the compiled test files into shards that run as separate CI jobs (the Windows runner needs
// about 45 minutes for the whole suite and a quarter of that for one of four shards).
//
// The split is by file size, greedily and deterministically: the biggest file goes to the lightest
// shard, ties to the lowest index. Every shard builds the same files, so every shard computes the same
// partition from the same sizes, and no file runs twice or not at all.

const MAX_SHARDS = 64;

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
