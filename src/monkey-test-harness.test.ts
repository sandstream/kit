import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MONKEY_HARNESS_FILES } from "./monkey-test-contract.js";
import { writeMonkeyHarness } from "./monkey-test-harness.js";

describe("monkey-test harness writer", () => {
  it("creates the complete harness and preserves operator-owned files", async () => {
    const root = await mkdtemp(join(tmpdir(), "kit-monkey-harness-"));
    try {
      const first = await writeMonkeyHarness(root);
      assert.equal(first.ok, true);
      assert.deepEqual(
        first.writes.map(({ path }) => path).sort(),
        [...MONKEY_HARNESS_FILES].sort(),
      );

      const operatorFile = join(root, "tests", "monkey", "README.md");
      await writeFile(operatorFile, "operator owned\n", "utf8");
      const second = await writeMonkeyHarness(root);
      assert.equal(second.ok, false);
      assert.equal(
        second.writes.find(({ path }) => path === "tests/monkey/README.md")?.action,
        "skipped",
      );
      assert.equal(await readFile(operatorFile, "utf8"), "operator owned\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
