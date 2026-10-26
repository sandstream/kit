import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractText } from "./content.js";
import { extractText as fromParser } from "./parser.js";

describe("memory content flattening", () => {
  it("joins text blocks and marks tool calls and results", () => {
    assert.equal(
      extractText([
        { type: "text", text: "hello" },
        { type: "tool_use", name: "Bash" },
        { type: "tool_result" },
        { type: "image" },
      ]),
      "hello\n[Tool: Bash]\n[Tool Result]",
    );
    assert.equal(extractText("plain"), "plain");
    assert.equal(extractText(undefined), "");
  });

  it("is the same function the parser re-exports", () => {
    assert.equal(fromParser, extractText);
  });
});
