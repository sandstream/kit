import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_BLOCK_BEGIN, KIT_BLOCK_END, KIT_INSTRUCTION } from "./agent-config.js";

/**
 * README ↔ managed-block drift gate.
 *
 * The bootstrap section shows users the EXACT managed block the one-liner will
 * turn into — the whole point is transparency, so a stale example is worse
 * than none (it promises one thing and writes another). This pins the README's
 * quoted block to the KIT_INSTRUCTION the code actually writes; change either
 * side and the build says so.
 */
describe("README bootstrap section ↔ KIT_INSTRUCTION", () => {
  const readme = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"),
    "utf8",
  );

  it("quotes the real managed block, markers included, verbatim", () => {
    const expected = `${KIT_BLOCK_BEGIN}\n${KIT_INSTRUCTION}\n${KIT_BLOCK_END}`;
    assert.ok(
      readme.includes(expected),
      "README's transparent-end-state example drifted from the KIT_INSTRUCTION the code writes — update the README block (or, if the instruction changed deliberately, the README example) so the promise stays true",
    );
  });
});
