import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
type Shard = { index: number; total: number };
const { parseShard, selectShard, weightFrom } = (await import(
  pathToFileURL(join(ROOT, "scripts", "test-shard.mjs")).href
)) as {
  parseShard: (spec: string | undefined) => Shard | null;
  selectShard: (files: string[], shard: Shard, sizeOf: (f: string) => number) => string[];
  weightFrom: (
    table: { files?: Record<string, number> } | null,
    sizeOf: (f: string) => number,
  ) => (f: string) => number;
};

const SIZES: Record<string, number> = {
  "dist/a.test.js": 900,
  "dist/b.test.js": 700,
  "dist/c.test.js": 400,
  "dist/d.test.js": 300,
  "dist/e.test.js": 200,
  "dist/f.test.js": 100,
  "dist/g.test.js": 50,
};
const FILES = Object.keys(SIZES);
const sizeOf = (f: string) => SIZES[f] ?? 0;

describe("parseShard", () => {
  it("reads index/total", () => {
    assert.deepEqual(parseShard("2/4"), { index: 2, total: 4 });
    assert.deepEqual(parseShard("1/1"), { index: 1, total: 1 });
  });

  it("means no sharding when the value is absent or empty", () => {
    assert.equal(parseShard(undefined), null);
    assert.equal(parseShard(""), null);
  });

  it("rejects a value that is not a shard, with the variable's name", () => {
    for (const bad of ["0/4", "5/4", "2/0", "a/b", "2", "2/4/1", "-1/4", "1/65", "1.5/4", " 2/4"]) {
      assert.throws(() => parseShard(bad), /KIT_TEST_SHARD/, bad);
    }
  });
});

describe("selectShard", () => {
  const all = (total: number) =>
    Array.from({ length: total }, (_, i) => selectShard(FILES, { index: i + 1, total }, sizeOf));

  it("covers every file exactly once across the shards", () => {
    for (const total of [1, 2, 3, 4, 7]) {
      const parts = all(total).flat();
      assert.deepEqual([...parts].sort(), [...FILES].sort(), `total ${total}`);
    }
  });

  it("returns everything for 1/1", () => {
    assert.deepEqual(selectShard(FILES, { index: 1, total: 1 }, sizeOf).sort(), [...FILES].sort());
  });

  it("does not depend on the order the files were listed in", () => {
    const reversed = [...FILES].reverse();
    for (let i = 1; i <= 3; i++) {
      assert.deepEqual(
        selectShard(reversed, { index: i, total: 3 }, sizeOf),
        selectShard(FILES, { index: i, total: 3 }, sizeOf),
      );
    }
  });

  it("balances by size: no shard is more than the largest file heavier than another", () => {
    const sums = all(3).map((files) => files.reduce((n, f) => n + sizeOf(f), 0));
    assert.ok(Math.max(...sums) - Math.min(...sums) <= 900, JSON.stringify(sums));
  });

  it("gives every shard at least one file when there are enough files", () => {
    for (const files of all(4)) assert.ok(files.length >= 1);
  });

  it("returns each shard's files sorted by name", () => {
    for (const files of all(3)) assert.deepEqual(files, [...files].sort());
  });
});

describe("weightFrom", () => {
  const sizes: Record<string, number> = {
    "dist/a.test.js": 100,
    "dist/b.test.js": 300,
    "dist/new.test.js": 50,
  };
  const size = (f: string): number => sizes[f.split("\\").join("/")] ?? 0;

  it("uses the measured time, matching Windows separators to the table's", () => {
    const w = weightFrom({ files: { "dist/a.test.js": 9000, "dist/b.test.js": 3000 } }, size);
    assert.equal(w("dist/a.test.js"), 9000);
    assert.equal(w("dist\\b.test.js"), 3000);
  });

  it("weights an unknown file by size at the table's own ms-per-byte rate", () => {
    const w = weightFrom({ files: { "dist/a.test.js": 9000, "dist/b.test.js": 3000 } }, size);
    assert.equal(w("dist/new.test.js"), 50 * (12000 / 400));
  });

  it("falls back to plain size without a table", () => {
    assert.equal(weightFrom(null, size)("dist/b.test.js"), 300);
  });

  it("lets a measured heavy file pull a shard apart from its size", () => {
    const files = ["dist/a.test.js", "dist/b.test.js"];
    const w = weightFrom({ files: { "dist/a.test.js": 9000, "dist/b.test.js": 3000 } }, size);
    assert.deepEqual(selectShard(files, { index: 1, total: 2 }, w), ["dist/a.test.js"]);
    assert.deepEqual(selectShard(files, { index: 1, total: 2 }, size), ["dist/b.test.js"]);
  });
});

describe("scripts/test.mjs", () => {
  it("refuses a malformed KIT_TEST_SHARD before it runs anything", () => {
    const run = spawnSync(process.execPath, [join(ROOT, "scripts", "test.mjs")], {
      cwd: ROOT,
      env: { ...process.env, KIT_TEST_SHARD: "9/4" },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /KIT_TEST_SHARD/);
  });

  it("refuses a malformed KIT_TEST_CONCURRENCY before it runs anything", () => {
    const run = spawnSync(process.execPath, [join(ROOT, "scripts", "test.mjs")], {
      cwd: ROOT,
      env: { ...process.env, KIT_TEST_CONCURRENCY: "0" },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /KIT_TEST_CONCURRENCY must be a positive integer/);
  });
});
