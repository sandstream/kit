import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCoChangeLog, coChangeCounts, topCoChanged, COCHANGE_SEP } from "./cochange.js";

// Build a fake `git log --name-only --format=<SEP>%H` blob from commits (arrays of files).
const log = (commits: string[][]) =>
  commits.map((files) => `${COCHANGE_SEP}deadbeef\n${files.join("\n")}\n`).join("");

describe("repomap cochange — parseCoChangeLog", () => {
  it("parses one file-set per commit; skips single-file and empty commits", () => {
    const raw = log([["a.ts", "b.ts"], ["solo.ts"], ["a.ts", "b.ts", "c.ts"]]);
    assert.deepEqual(parseCoChangeLog(raw), [
      ["a.ts", "b.ts"],
      ["a.ts", "b.ts", "c.ts"],
    ]);
  });

  it("skips mega-commits over the file cap (coupling noise)", () => {
    const big = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    assert.deepEqual(parseCoChangeLog(log([big]), 5), [], "10-file commit dropped at cap 5");
    assert.equal(parseCoChangeLog(log([big]), 20).length, 1, "kept under a higher cap");
  });
});

describe("repomap cochange — counts + topCoChanged", () => {
  const sets = [
    ["a.ts", "b.ts"],
    ["a.ts", "b.ts"],
    ["a.ts", "c.ts"],
    ["a.ts", "b.ts", "c.ts"],
  ];
  const counts = coChangeCounts(sets);

  it("counts unordered pairs symmetrically", () => {
    assert.equal(counts.get("a.ts")?.get("b.ts"), 3);
    assert.equal(counts.get("b.ts")?.get("a.ts"), 3);
    assert.equal(counts.get("a.ts")?.get("c.ts"), 2);
  });

  it("ranks a file's partners by count (path tie-break), min-count filtered", () => {
    assert.deepEqual(topCoChanged(counts, "a.ts"), [
      { file: "b.ts", count: 3 },
      { file: "c.ts", count: 2 },
    ]);
  });

  it("drops pairs seen only once (default minCount 2)", () => {
    const once = coChangeCounts([["x.ts", "y.ts"]]);
    assert.deepEqual(topCoChanged(once, "x.ts"), [], "a single shared commit is not a signal");
    assert.deepEqual(topCoChanged(once, "x.ts", 5, 1), [{ file: "y.ts", count: 1 }]);
  });

  it("returns [] for a file with no history", () => {
    assert.deepEqual(topCoChanged(counts, "unknown.ts"), []);
  });

  it("is deterministic", () => {
    assert.deepEqual(coChangeCounts(sets), coChangeCounts(sets));
  });
});
