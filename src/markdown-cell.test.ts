import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdownCell } from "./markdown-cell.js";

describe("markdownCell", () => {
  it("flattens line breaks and escapes pipes", () => {
    assert.equal(markdownCell("a\r\nb|c"), "a b\\|c");
  });

  it("keeps a pipe escaped after a trailing backslash", () => {
    // `\|` must not become `\\|`, where the pipe would end the cell.
    const cell = markdownCell("x\\|y");
    assert.equal(cell, "x\\\\\\|y");
    assert.doesNotMatch(cell.replace(/\\./g, ""), /\|/);
  });
});
