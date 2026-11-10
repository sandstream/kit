import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfAudit } from "./self-audit.js";
import { rmTemp } from "./temp-cleanup.test-support.js";

describe("R1b-nan-fresh: the compared value", () => {
  for (const [expression, expected] of [
    ["items.length > 0", "pass"],
    ["items?.length > 0", "pass"],
    ["items. length > 0", "pass"],
    ["items.\n length > 0", "pass"],
    ["length < 10", "warn"],
  ] as const) {
    it(`identifies the compared value in ${expression}`, () => {
      const root = mkdtempSync(join(tmpdir(), "kit-nan-member-"));
      try {
        mkdirSync(join(root, "src"));
        writeFileSync(
          join(root, "src/input.ts"),
          `function inspect(raw, items) {
  const length = Number(raw);
  return ${expression};
}`,
        );
        const result = runSelfAudit(root, { only: ["R1b-nan-fresh"] });
        assert.equal(result.length, 1);
        assert.equal(result[0].status, expected);
      } finally {
        rmTemp(root);
      }
    });
  }
});
