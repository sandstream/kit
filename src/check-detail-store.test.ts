import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  chmodSync,
  mkdirSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCheckDetail, pruneCheckDetails, RUNS_DIR, KEEP_RUNS } from "./check-detail-store.js";

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), "kit-runs-"));
}

describe("writeCheckDetail", () => {
  it("writes the payload where the returned path says it did", () => {
    const cwd = tmpProject();
    const ref = writeCheckDetail(cwd, { ok: true, security: [] }, 1000);
    assert.ok(ref, "expected a reference");
    // The whole point of the reference: it has to resolve. Reading it back IS the assertion.
    assert.deepEqual(JSON.parse(readFileSync(ref.path, "utf-8")), { ok: true, security: [] });
    assert.equal(ref.path, join(cwd, RUNS_DIR, "check-1000.json"));
  });

  it("returns null instead of a dangling reference when the write fails", () => {
    const cwd = tmpProject();
    // A .kit that cannot be written into: mkdir of .kit/runs fails, so there is no file.
    mkdirSync(join(cwd, ".kit"));
    chmodSync(join(cwd, ".kit"), 0o500);
    try {
      assert.equal(writeCheckDetail(cwd, { ok: true }, 1000), null);
    } finally {
      chmodSync(join(cwd, ".kit"), 0o700);
    }
  });

  it("keeps the newest runs and drops the rest", () => {
    const cwd = tmpProject();
    for (let i = 1; i <= KEEP_RUNS + 3; i++) writeCheckDetail(cwd, { run: i }, i);
    const left = readdirSync(join(cwd, RUNS_DIR)).sort();
    assert.equal(left.length, KEEP_RUNS);
    // The three oldest stamps are the ones gone — pruning is by run order, not by mtime.
    assert.ok(!left.includes("check-1.json"));
    assert.ok(!left.includes("check-3.json"));
    assert.ok(left.includes(`check-${KEEP_RUNS + 3}.json`));
  });

  it("sorts by stamp numerically, not lexically", () => {
    const cwd = tmpProject();
    // 9 would beat 100 under a string sort, and the newest run would be the one deleted.
    for (const stamp of [9, 100, 101, 102]) writeCheckDetail(cwd, { stamp }, stamp);
    assert.deepEqual(pruneCheckDetails(cwd, 2).sort(), ["check-100.json", "check-9.json"]);
    const left = readdirSync(join(cwd, RUNS_DIR)).sort();
    assert.deepEqual(left, ["check-101.json", "check-102.json"]);
  });
});

describe("pruneCheckDetails", () => {
  it("is a no-op when nothing was ever written", () => {
    const cwd = tmpProject();
    assert.deepEqual(pruneCheckDetails(cwd), []);
    assert.equal(existsSync(join(cwd, RUNS_DIR)), false);
  });

  it("leaves files this store did not write alone", () => {
    const cwd = tmpProject();
    writeCheckDetail(cwd, { ok: true }, 1);
    const dir = join(cwd, RUNS_DIR);
    const foreign = join(dir, "notes.md");
    writeFileSync(foreign, "not ours\n");
    pruneCheckDetails(cwd, 0);
    assert.equal(existsSync(foreign), true, "an unrelated file must survive pruning");
    assert.equal(existsSync(join(dir, "check-1.json")), false);
  });
});
