import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadFindings,
  otherInputs,
  readResult,
  receiptPayload,
  saveFindings,
  sha256,
  summarise,
  writeResult,
  type RigResult,
} from "./store.js";
import type { ConfigStats } from "./report.js";
import { rmTemp } from "../temp-cleanup.test-support.js";

const ID = "e".repeat(64);
const OTHER = "f".repeat(64);

const stats: ConfigStats[] = [
  {
    config: "B",
    tune: {
      runs: 3,
      recall: { mean: 0.123456, min: 0, max: 0.5 },
      falsePositiveRate: null,
      perDefect: {},
    },
    holdout: { runs: 0, recall: null, falsePositiveRate: null, perDefect: {} },
    controls: { runs: 3, falsePositiveRate: { mean: 1 / 3, min: 0, max: 1 } },
  },
  {
    config: "A",
    tune: { runs: 3, recall: { mean: 1, min: 1, max: 1 }, falsePositiveRate: null, perDefect: {} },
    holdout: {
      runs: 3,
      recall: { mean: 0.5, min: 0, max: 1 },
      falsePositiveRate: null,
      perDefect: {},
    },
    controls: { runs: 0, falsePositiveRate: null },
  },
];

describe("saveFindings and loadFindings", () => {
  it("stores each file once under its hash and loads them in hash order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-rig-store-"));
    try {
      const a = await saveFindings(dir, ID, "a\n");
      const again = await saveFindings(dir, ID, "a\n");
      const b = await saveFindings(dir, ID, "b\n");
      assert.deepEqual([a.added, again.added, b.added], [true, false, true]);
      assert.equal(a.sha, sha256("a\n"));
      const loaded = await loadFindings(dir, ID);
      assert.deepEqual(
        loaded.map((f) => f.sha),
        [a.sha, b.sha].sort(),
      );
      assert.deepEqual(await loadFindings(dir, OTHER), []);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("writeResult, readResult and otherInputs", () => {
  it("round-trips a result and lists the other inputs on record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kit-rig-result-"));
    try {
      const result = {
        inputId: ID,
        adjudicatedAt: "2026-10-31T00:00:00.000Z",
        outcomes: [],
        unknownTargets: [],
        stats,
        warnings: [],
        receipt: { inputId: ID, findings: [], summary: {}, signature: null },
      } satisfies RigResult;
      await writeResult(dir, result);
      await saveFindings(dir, OTHER, "x\n");
      assert.deepEqual(await readResult(dir, ID), result);
      assert.equal(await readResult(dir, OTHER), null);
      assert.deepEqual(await otherInputs(dir, ID), [OTHER]);
    } finally {
      rmTemp(dir);
    }
  });
});

describe("summarise and receiptPayload", () => {
  it("rounds to four places and signs the same bytes whatever the order", () => {
    const summary = summarise(stats);
    assert.deepEqual(summary.B, { tuneRecall: 0.1235, holdoutRecall: null, controlFpRate: 0.3333 });
    const reordered = Object.fromEntries(Object.entries(summary).reverse());
    assert.equal(
      receiptPayload(ID, ["2", "1"], summary),
      receiptPayload(ID, ["1", "2"], reordered),
    );
    assert.match(receiptPayload(ID, [], summary), /"kind":"kit-rig-receipt-v1"/);
  });
});
