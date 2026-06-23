import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBaseline,
  saveBaseline,
  baselineGet,
  baselineSet,
  BASELINE_FILE,
  type Baseline,
} from "./baseline.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "kit-baseline-"));
}

describe("loadBaseline", () => {
  it("returns empty-baseline when file does not exist", async () => {
    const dir = tmp();
    try {
      const b = await loadBaseline(dir);
      assert.equal(b.version, 1);
      assert.deepEqual(b.categories, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads + parses existing baseline JSON", async () => {
    const dir = tmp();
    try {
      writeFileSync(
        join(dir, BASELINE_FILE),
        JSON.stringify({
          version: 1,
          generated: "2026-01-01T00:00:00Z",
          categories: {
            tests: { untested_files: ["src/a.ts", "src/b.ts"] },
          },
        }),
      );
      const b = await loadBaseline(dir);
      assert.deepEqual(b.categories.tests.untested_files, ["src/a.ts", "src/b.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported version", async () => {
    const dir = tmp();
    try {
      writeFileSync(
        join(dir, BASELINE_FILE),
        JSON.stringify({ version: 2, generated: "x", categories: {} }),
      );
      await assert.rejects(() => loadBaseline(dir), /unsupported baseline version: 2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON with file-context error", async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, BASELINE_FILE), "{not-json");
      await assert.rejects(
        () => loadBaseline(dir),
        new RegExp(`failed to read ${BASELINE_FILE.replace(".", "\\.")}`),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("baselineGet / baselineSet", () => {
  it("baselineGet returns [] for missing category+key", () => {
    const b: Baseline = { version: 1, generated: "x", categories: {} };
    assert.deepEqual(baselineGet(b, "tests", "untested_files"), []);
  });

  it("baselineSet sorts entries and is idempotent", () => {
    const b: Baseline = { version: 1, generated: "x", categories: {} };
    baselineSet(b, "tests", "untested_files", ["b", "a", "c"]);
    assert.deepEqual(b.categories.tests.untested_files, ["a", "b", "c"]);
    // Re-set with same set → identical sorted output.
    baselineSet(b, "tests", "untested_files", ["c", "a", "b"]);
    assert.deepEqual(b.categories.tests.untested_files, ["a", "b", "c"]);
  });

  it("baselineSet with empty array drops the key (and category if empty)", () => {
    const b: Baseline = {
      version: 1,
      generated: "x",
      categories: { tests: { untested_files: ["a"] } },
    };
    baselineSet(b, "tests", "untested_files", []);
    assert.equal(b.categories.tests, undefined);
  });

  it("baselineSet preserves other keys when dropping one", () => {
    const b: Baseline = {
      version: 1,
      generated: "x",
      categories: { tests: { untested_files: ["a"], slow_files: ["b"] } },
    };
    baselineSet(b, "tests", "untested_files", []);
    assert.equal(b.categories.tests.untested_files, undefined);
    assert.deepEqual(b.categories.tests.slow_files, ["b"]);
  });

  it("baselineSet creates category lazily", () => {
    const b: Baseline = { version: 1, generated: "x", categories: {} };
    baselineSet(b, "design", "a11y", ["color-contrast"]);
    assert.deepEqual(b.categories.design.a11y, ["color-contrast"]);
  });
});

describe("saveBaseline", () => {
  it("writes the JSON + updates `generated` timestamp", async () => {
    const dir = tmp();
    try {
      const b: Baseline = {
        version: 1,
        generated: "1970-01-01T00:00:00.000Z",
        categories: { tests: { untested_files: ["src/x.ts"] } },
      };
      const before = Date.now();
      await saveBaseline(b, dir);
      const after = Date.now();
      const text = readFileSync(join(dir, BASELINE_FILE), "utf-8");
      const parsed = JSON.parse(text);
      assert.deepEqual(parsed.categories.tests.untested_files, ["src/x.ts"]);
      const ts = Date.parse(parsed.generated);
      assert.ok(ts >= before && ts <= after, "generated timestamp updated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips load → save → load", async () => {
    const dir = tmp();
    try {
      const b: Baseline = {
        version: 1,
        generated: "x",
        categories: { tests: { untested_files: ["a", "b"] } },
      };
      await saveBaseline(b, dir);
      const reloaded = await loadBaseline(dir);
      assert.deepEqual(reloaded.categories.tests.untested_files, ["a", "b"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
