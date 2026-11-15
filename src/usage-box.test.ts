import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { WIDTH, bar, clip, line, num, plain, rule } from "./usage-box.js";

describe("usage box primitives", () => {
  it("clip marks a cut with an ellipsis and leaves short text alone", () => {
    assert.equal(clip("abcdef", 4), "abc…");
    assert.equal(clip("abc", 4), "abc");
  });

  it("every row and rule is exactly as wide as the box, however long its content", () => {
    const rowWidth = WIDTH + 4; // border, space, content, space, border
    for (const row of [
      line("short", "1"),
      line("x".repeat(200), "12,345"),
      line("x".repeat(200), "y".repeat(80)),
    ]) {
      assert.equal(plain(row).length, rowWidth);
    }
    assert.equal(plain(rule("Floor")).length, rowWidth);
  });

  it("keeps the number column exact when it trims the label", () => {
    const row = plain(line("x".repeat(200), "12,345"));
    assert.match(row, /…\s+12,345 │$/);
  });

  it("formats numbers and bars", () => {
    assert.equal(num(1234567), "1,234,567");
    assert.equal(bar(1, 0), "");
    assert.equal(plain(bar(1, 2, 10)), "█████░░░░░");
  });
});
