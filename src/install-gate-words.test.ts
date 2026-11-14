import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shellSegments, shellWords, shellWordValue } from "./install-gate-words.js";

describe("install-gate shell words", () => {
  it("keeps a quoted or escaped space inside one word", () => {
    assert.deepEqual(shellWords('npm i "a b" x\\ y'), ["npm", "i", '"a b"', "x\\ y"]);
  });

  it("returns the value a shell would pass for a quoted or escaped word", () => {
    assert.equal(shellWordValue('"a b"'), "a b");
    assert.equal(shellWordValue("x\\ y"), "x y");
  });

  it("splits segments at unquoted separators only", () => {
    assert.deepEqual(
      shellSegments('npm i a; echo "x;y" && ls | wc').map((s) => s.trim()),
      ["npm i a", 'echo "x;y"', "ls", "wc"],
    );
  });
});
